export interface VpsHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
  passwordEnc: string;
  tags: string[];
  notes: string;
  writable: boolean;
  allowedServices: string[] | null;
  repo: string;
  branch: string;
  deployPath: string;
  deployCmd: string;
}

export interface CodeRepo {
  id: string;
  name: string;
  githubRepo: string;
  branch: string;
  deployPath: string;
  deployCmd: string;
  notes: string;
  intro: string;
}

export interface UserSession {
  currentVpsId: string | null;
  lastRepoId: string | null;
  chatOn: boolean;
  agents: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}
