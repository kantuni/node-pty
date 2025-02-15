/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Socket } from 'net';
import { ArgvOrCommandLine } from './types';
import { fork } from 'child_process';
import { ConoutConnection } from './windowsConoutConnection';
import { requireBinary } from './requireBinary';

let conptyNative: IConptyNative;

/**
 * The amount of time to wait for additional data after the conpty shell process has exited before
 * shutting down the socket. The timer will be reset if a new data event comes in after the timer
 * has started.
 */
const FLUSH_DATA_INTERVAL = 1000;

/**
 * This agent sits between the WindowsTerminal class and provides an interface for both conpty.
 */
export class WindowsPtyAgent {
  private _inSocket: Socket;
  private _outSocket: Socket;
  private _pid: number = 0;
  private _innerPid: number = 0;
  private _closeTimeout: NodeJS.Timer | undefined;
  private _exitCode: number | undefined;
  private _conoutSocketWorker: ConoutConnection;

  private _fd: any;
  private _pty: number;
  private _ptyNative: IConptyNative;

  public get inSocket(): Socket { return this._inSocket; }
  public get outSocket(): Socket { return this._outSocket; }
  public get fd(): any { return this._fd; }
  public get innerPid(): number { return this._innerPid; }
  public get pty(): number { return this._pty; }

  constructor(
    file: string,
    args: ArgvOrCommandLine,
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    debug: boolean,
    conptyInheritCursor: boolean = false
  ) {
    if (!conptyNative) {
      conptyNative = requireBinary<IConptyNative>('conpty.node');
    }
    this._ptyNative = conptyNative;

    // Sanitize input variable.
    cwd = path.resolve(cwd);

    // Compose command line
    const commandLine = argsToCommandLine(file, args);

    // Open pty session.
    const term: IConptyProcess = this._ptyNative.startProcess(file, cols, rows, debug, this._generatePipeName(), conptyInheritCursor);

    // Not available on windows.
    this._fd = term.fd;

    // Generated incremental number that has no real purpose besides  using it
    // as a terminal id.
    this._pty = term.pty;

    // Create terminal pipe IPC channel and forward to a local unix socket.
    this._outSocket = new Socket();
    this._outSocket.setEncoding('utf8');
    // The conout socket must be ready out on another thread to avoid deadlocks
    this._conoutSocketWorker = new ConoutConnection(term.conout);
    this._conoutSocketWorker.onReady(() => {
      this._conoutSocketWorker.connectSocket(this._outSocket);
    });
    this._outSocket.on('connect', () => {
      this._outSocket.emit('ready_datapipe');
    });

    const inSocketFD = fs.openSync(term.conin, 'w');
    this._inSocket = new Socket({
      fd: inSocketFD,
      readable: false,
      writable: true
    });
    this._inSocket.setEncoding('utf8');

    const connect = (this._ptyNative as IConptyNative).connect(this._pty, commandLine, cwd, env, c => this._$onProcessExit(c));
    this._innerPid = connect.pid;
  }

  public resize(cols: number, rows: number): void {
    if (this._exitCode !== undefined) {
      throw new Error('Cannot resize a pty that has already exited');
    }
    this._ptyNative.resize(this._pty, cols, rows);
  }

  public clear(): void {
    this._ptyNative.clear(this._pty);
  }

  public kill(): void {
    this._inSocket.readable = false;
    this._outSocket.readable = false;
    // Tell the agent to kill the pty, this releases handles to the process
    this._getConsoleProcessList().then(consoleProcessList => {
      consoleProcessList.forEach((pid: number) => {
        try {
          process.kill(pid);
        } catch (e) {
          // Ignore if process cannot be found (kill ESRCH error)
        }
      });
      this._ptyNative.kill(this._pty);
    });
    this._conoutSocketWorker.dispose();
  }

  private _getConsoleProcessList(): Promise<number[]> {
    return new Promise<number[]>(resolve => {
      const agent = fork(path.join(__dirname, 'conpty_console_list_agent'), [ this._innerPid.toString() ]);
      agent.on('message', message => {
        clearTimeout(timeout);
        resolve(message.consoleProcessList);
      });
      const timeout = setTimeout(() => {
        // Something went wrong, just send back the shell PID
        agent.kill();
        resolve([ this._innerPid ]);
      }, 5000);
    });
  }

  public get exitCode(): number | undefined {
    return this._exitCode;
  }

  private _generatePipeName(): string {
    return `conpty-${Math.random() * 10000000}`;
  }

  /**
   * Triggered from the native side when a contpy process exits.
   */
  private _$onProcessExit(exitCode: number): void {
    this._exitCode = exitCode;
    this._flushDataAndCleanUp();
    this._outSocket.on('data', () => this._flushDataAndCleanUp());
  }

  private _flushDataAndCleanUp(): void {
    if (this._closeTimeout) {
      clearTimeout(this._closeTimeout);
    }
    this._closeTimeout = setTimeout(() => this._cleanUpProcess(), FLUSH_DATA_INTERVAL);
  }

  private _cleanUpProcess(): void {
    this._inSocket.readable = false;
    this._outSocket.readable = false;
    this._outSocket.destroy();
  }
}

// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN (e.g. see CommandLineToArgvW documentation). Copied from
// winpty project.
export function argsToCommandLine(file: string, args: ArgvOrCommandLine): string {
  if (isCommandLine(args)) {
    if (args.length === 0) {
      return file;
    }
    return `${argsToCommandLine(file, [])} ${args}`;
  }
  const argv = [file];
  Array.prototype.push.apply(argv, args);
  let result = '';
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) {
      result += ' ';
    }
    const arg = argv[argIndex];
    // if it is empty or it contains whitespace and is not already quoted
    const hasLopsidedEnclosingQuote = xOr((arg[0] !== '"'), (arg[arg.length - 1] !== '"'));
    const hasNoEnclosingQuotes = ((arg[0] !== '"') && (arg[arg.length - 1] !== '"'));
    const quote =
      arg === '' ||
      (arg.indexOf(' ') !== -1 ||
      arg.indexOf('\t') !== -1) &&
      ((arg.length > 1) &&
      (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes));
    if (quote) {
      result += '\"';
    }
    let bsCount = 0;
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i];
      if (p === '\\') {
        bsCount++;
      } else if (p === '"') {
        result += repeatText('\\', bsCount * 2 + 1);
        result += '"';
        bsCount = 0;
      } else {
        result += repeatText('\\', bsCount);
        bsCount = 0;
        result += p;
      }
    }
    if (quote) {
      result += repeatText('\\', bsCount * 2);
      result += '\"';
    } else {
      result += repeatText('\\', bsCount);
    }
  }
  return result;
}

function isCommandLine(args: ArgvOrCommandLine): args is string {
  return typeof args === 'string';
}

function repeatText(text: string, count: number): string {
  let result = '';
  for (let i = 0; i < count; i++) {
    result += text;
  }
  return result;
}

function xOr(arg1: boolean, arg2: boolean): boolean {
  return ((arg1 && !arg2) || (!arg1 && arg2));
}
