import { spawn } from 'node:child_process';
export interface SecretVault {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  exclusive?<T>(name: string, work: () => Promise<T>): Promise<T>;
}
export class NativeVault implements SecretVault {
  executable: string;
  private dataDirectory?: string;
  constructor(executable: string, dataDirectory?: string) {
    this.executable = executable;
    this.dataDirectory = dataDirectory;
  }
  private run(operation: string, key: string, input = ''): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--secret', operation, key], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.dataDirectory
          ? { ...process.env, WISP_DATA_DIR: this.dataDirectory }
          : process.env,
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Native credential storage timed out'));
      }, 10000);
      child.stdout.on('data', (data) => {
        output += data;
        if (output.length > 1024 * 1024) {
          child.kill();
          reject(Error('Secret is too large'));
        }
      });
      child.stderr.resume();
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(output);
        } else {
          reject(Error('Native credential storage failed'));
        }
      });
      child.stdin.end(input);
    });
  }
  read(key: string) {
    return this.run('read', key);
  }
  async write(key: string, value: string) {
    await this.run('write', key, value);
  }
}

export class SharedModelVault implements SecretVault {
  private local: SecretVault;
  private shared: SecretVault;
  readonly exclusive: NonNullable<SecretVault['exclusive']>;
  constructor(
    local: SecretVault,
    shared: SecretVault,
    exclusive: NonNullable<SecretVault['exclusive']>,
  ) {
    this.local = local;
    this.shared = shared;
    this.exclusive = exclusive;
  }
  private target(key: string) {
    return key === 'chatgpt:accounts' || key.startsWith('ai-connection:')
      ? this.shared
      : this.local;
  }
  read(key: string) {
    return this.target(key).read(key);
  }
  write(key: string, value: string) {
    return this.target(key).write(key, value);
  }
}
