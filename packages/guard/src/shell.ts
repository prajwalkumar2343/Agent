/**
 * Shell command vetting for the agent's runShell tool — modeled on codex's
 * execpolicy + command canonicalization. The command string is lexed into
 * individual argv segments (pipes, &&, ;, subshells, substitutions all split
 * out), each argv0 is normalized and unwrapped through env/nice/timeout
 * wrappers, then vetted against prefix rules and path policies. Strictest
 * decision wins; anything we can't safely parse is denied — there is no
 * human to prompt.
 */

export type ShellDecision = 'allow' | 'deny';

export interface ShellVerdict {
  decision: ShellDecision;
  reason: string;
}

const ALLOW: ShellVerdict = { decision: 'allow', reason: '' };
const deny = (reason: string): ShellVerdict => ({ decision: 'deny', reason });

/* ------------------------------- lexer ------------------------------- */

interface Lexed {
  /** Individual command texts between control operators. */
  segments: string[];
  /** Redirection targets (>, >>, <, 2>, &>) that are real paths. */
  redirects: string[];
  /** Texts inside $(...) / `...` / <(...) / >(...) — recursively vetted. */
  subshells: string[];
  /** True when the lexer hit syntax it can't vet. */
  unparseable: boolean;
}

const VAR = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function lex(cmd: string): Lexed {
  const out: Lexed = { segments: [], redirects: [], subshells: [], unparseable: false };
  let cur = '';
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (cur.trim()) out.segments.push(cur);
    cur = '';
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c + (cmd[++i] ?? '');
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; cur += c; continue; }
      if (c === '`' || (c === '$' && cmd[i + 1] === '(')) {
        const [inner, next] = captureSubshell(cmd, i);
        if (inner === null) { out.unparseable = true; return out; }
        out.subshells.push(inner);
        cur += ' $X ';
        i = next;
        continue;
      }
      if (c === '$' && cmd[i + 1] === '{') {
        const [name, next] = captureBracedVar(cmd, i);
        if (name === null) { out.unparseable = true; return out; }
        cur += `$${name}`;
        i = next;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '#') { while (i < cmd.length && cmd[i] !== '\n') i++; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) {
      const [inner, next] = captureSubshell(cmd, i);
      if (inner === null) { out.unparseable = true; return out; }
      out.subshells.push(inner);
      cur += ' $X ';
      i = next;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '{') {
      const [name, next] = captureBracedVar(cmd, i);
      if (name === null) { out.unparseable = true; return out; }
      cur += `$${name}`;
      i = next;
      continue;
    }
    if ((c === '<' || c === '>') && cmd[i + 1] === '(') {
      const [inner, next] = captureSubshell(cmd, i);
      if (inner === null) { out.unparseable = true; return out; }
      out.subshells.push(inner);
      i = next;
      continue;
    }
    if (c === '>' || c === '<') {
      if (cmd[i + 1] === '>' || cmd[i + 1] === '&' || cmd[i + 1] === '<' || cmd[i + 1] === '|') i++;
      let j = i + 1;
      while (j < cmd.length && /[ \t]/.test(cmd[j]!)) j++;
      let target = '';
      let tq: string | null = null;
      while (j < cmd.length) {
        const t = cmd[j]!;
        if (tq) { if (t === tq) tq = null; else target += t; j++; continue; }
        if (t === "'" || t === '"') { tq = t; j++; continue; }
        if (/[ \t|;&<>()]/.test(t)) break;
        target += t; j++;
      }
      if (target && !target.startsWith('&') && target !== '-' && !/^\d+$/.test(target)) {
        out.redirects.push(target);
      }
      i = j - 1;
      cur += ' ';
      continue;
    }
    if (c === '|' || c === '&') {
      if (cmd[i + 1] === c) i++;
      flush();
      continue;
    }
    if (';\n(){}'.includes(c)) {
      flush();
      continue;
    }
    cur += c;
  }
  if (quote) out.unparseable = true;
  flush();
  return out;
}

/** Extract inner text of `...` or $( ...) / <( ...) / >( ...) at index i. */
function captureSubshell(cmd: string, i: number): [inner: string | null, next: number] {
  if (cmd[i] === '`') {
    const end = cmd.indexOf('`', i + 1);
    return end === -1 ? [null, i] : [cmd.slice(i + 1, end), end];
  }
  // cmd[i] is $ < or >; the paren is at i+1
  let depth = 0;
  const start = i + 2;
  for (let j = i + 1; j < cmd.length; j++) {
    if (cmd[j] === '\\') { j++; continue; }
    if (cmd[j] === '(') depth++;
    else if (cmd[j] === ')' && --depth === 0) return [cmd.slice(start, j), j];
  }
  return [null, i];
}

/** Extract NAME from ${NAME...} at index i (parameter ops collapsed). */
function captureBracedVar(cmd: string, i: number): [name: string | null, next: number] {
  let j = i + 2;
  while (j < cmd.length && cmd[j] !== '}') j++;
  if (j >= cmd.length) return [null, i];
  const name = cmd.slice(i + 2, j).split(/[^A-Za-z0-9_]/)[0];
  return [name ?? null, j];
}

/* ------------------------- tokenize a segment ------------------------- */

function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && '"\\$`'.includes(seg[i + 1] ?? '')) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { cur += seg[++i] ?? ''; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------ rules ------------------------------- */

const GIT_ALLOW = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'grep', 'blame',
  'rev-parse', 'rev-list', 'shortlog', 'describe', 'cat-file', 'reflog',
  'count-objects', 'var', 'check-ignore', 'name-rev', 'whatchanged',
]);

const FORBIDDEN_ARGV0 = new Set([
  'gh', 'hub', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp',
  'sftp', 'rsync', 'telnet', 'ftp', 'aria2c', 'axel', 'sudo', 'doas', 'eval',
  'exec', 'xargs', 'parallel', 'docker', 'kubectl', 'kubectx', 'helm',
  'terraform', 'vagrant', 'ansible', 'ansible-playbook', 'systemctl',
  'launchctl', 'crontab', 'at', 'batch', 'mount', 'umount', 'fdisk', 'mkfs',
  'dd', 'shred', 'wipe', 'cryptsetup', 'kill', 'pkill', 'killall',
  'printenv', 'history', 'source', '.', 'chroot',
]);

const PUBLISHERS = new Set(['npm', 'yarn', 'pnpm', 'bun', 'pip', 'pip3', 'gem', 'cargo', 'composer', 'poetry', 'uv', 'twine']);
const PUBLISH_SUB = new Set(['publish', 'adduser', 'login', 'logout', 'deploy', 'token', 'owner', 'access', 'push']);
const INLINE_EVAL = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'php']);
const INLINE_FLAGS = new Set(['-e', '-c', '--eval']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'csh', 'ksh', 'ash']);
const WRAPPERS = new Set(['nice', 'nohup', 'timeout', 'time', 'watch', 'stdbuf', 'taskset', 'chrt', 'ionice', 'env', 'command', 'builtin']);
const ENV_DUMPERS = new Set(['set', 'declare', 'compgen', 'export', 'typeset']);
const FORBIDDEN_ANYWHERE = new Set(['-exec', '-execdir', '-delete', '--no-preserve-root']);
/** Wrapper flags that carry a separate operand (nice -n 5, watch -n 2). */
const VALUE_FLAGS = new Set([
  '-n', '-c', '-o', '-e', '-z', '-p', '-i', '-t', '-g', '-u', '-S',
  '--interval', '--signal', '--kill-after', '--foreground', '--adjustment',
]);

const basename = (argv0: string) => argv0.split('/').pop() ?? argv0;

/** Path-like tokens that must never be touched regardless of location. */
const PROTECTED_FILE = /(^|\/)\.git($|\/)|(^|\/)\.env($|\.)|(^|\/)\.ssh($|\/)|(^|\/)id_[a-z0-9]+$|\.(pem|p12|pfx|key)$|(^|\/)etc\/(passwd|shadow)|(^|\/)proc\/|(^|\/)sys\//i;

/** Redirect targets that are always fine. */
const DEV_NULL = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/;

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

type Vars = Map<string, string>;

/** Expand $NAME references against the per-command var table; unknown → $X. */
function expand(token: string, vars: Vars): string {
  return token.replace(VAR, (_, name: string) => vars.get(name) ?? '$X');
}

function resolveRel(root: string, rel: string): string {
  const out: string[] = [];
  for (const p of (root + '/' + rel).split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

function pathVerdict(root: string, token: string, vars: Vars): ShellVerdict {
  const t = expand(token, vars);
  if (DEV_NULL.test(t)) return ALLOW;
  if (t.includes('$X')) return deny(`unresolvable variable in path position: ${token}`);
  if (PROTECTED_FILE.test(t)) return deny(`protected path: ${t}`);
  if (t.startsWith('~')) return deny(`home-relative path: ${t}`);
  if (t.startsWith('/')) {
    return t === root || t.startsWith(root + '/') ? ALLOW : deny(`absolute path outside workspace: ${t}`);
  }
  if (t.includes('..')) {
    const resolved = resolveRel(root, t);
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      return deny(`path escapes workspace: ${t}`);
    }
  }
  return ALLOW;
}

function extraForbiddenPrefixes(env: NodeJS.ProcessEnv): string[][] {
  return (env.SHELL_DENY_PREFIXES ?? '')
    .split(',')
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

/* ----------------------------- assessment ---------------------------- */

interface Ctx {
  root: string;
  env: NodeJS.ProcessEnv;
  vars: Vars;
}

export function assessShellCommand(
  cmd: string,
  opts: { root: string; env?: NodeJS.ProcessEnv },
): ShellVerdict {
  const ctx: Ctx = {
    root: opts.root.replace(/\/+$/, ''),
    env: opts.env ?? process.env,
    vars: new Map(),
  };
  const l = lex(cmd);
  if (l.unparseable) return deny('unparseable shell syntax — refusing to vet what we cannot see');

  for (const sub of l.subshells) {
    const v = assessShellCommand(sub, { root: ctx.root, env: ctx.env });
    if (v.decision === 'deny') return v;
  }
  for (const target of l.redirects) {
    const v = pathVerdict(ctx.root, target, ctx.vars);
    if (v.decision === 'deny') return deny(`redirect ${v.reason}`);
  }
  for (const seg of l.segments) {
    const v = assessSegment(tokenize(seg), ctx);
    if (v.decision === 'deny') return v;
  }
  return ALLOW;
}

function assessSegment(tokens: string[], ctx: Ctx): ShellVerdict {
  if (!tokens.length) return ALLOW;

  // Leading VAR=value assignments populate the per-command var table.
  let m: RegExpExecArray | null;
  while (tokens.length && (m = ASSIGN.exec(tokens[0]!))) {
    ctx.vars.set(m[1]!, m[2]!);
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return ALLOW;

  // Unwrap no-op wrappers: env, nice, timeout, nohup, command, ...
  while (tokens.length && WRAPPERS.has(basename(tokens[0]!))) {
    const w = basename(tokens[0]!);
    tokens = tokens.slice(1);
    while (tokens.length) {
      const a = tokens[0]!;
      if (a === '--') { tokens = tokens.slice(1); break; }
      const am = ASSIGN.exec(a);
      if (am) {
        ctx.vars.set(am[1]!, am[2]!);
        tokens = tokens.slice(1);
        continue;
      }
      if (/^-/.test(a)) {
        tokens = tokens.slice(1);
        // Flags that carry a separate value (nice -n 5, watch -n 2, ...).
        if (VALUE_FLAGS.has(a) && tokens.length) tokens = tokens.slice(1);
        continue;
      }
      // timeout's positional duration operand.
      if (w === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(a)) {
        tokens = tokens.slice(1);
        continue;
      }
      break;
    }
    if (!tokens.length) return deny(`bare '${w}' — env-dumping / no-op wrappers are denied`);
  }

  const argv0raw = expand(tokens[0]!, ctx.vars);
  const argv0 = basename(argv0raw);
  const args = tokens.slice(1);

  if (argv0.includes('$X') || argv0raw.startsWith('$')) {
    return deny('command name is a variable/expansion — refusing to vet');
  }

  // Ops-configured extra forbidden prefixes (SHELL_DENY_PREFIXES="docker,rake secret").
  for (const prefix of extraForbiddenPrefixes(ctx.env)) {
    const expanded = tokens.map((t) => expand(t, ctx.vars));
    if (expanded.length >= prefix.length && prefix.every((t, i) => expanded[i] === t)) {
      return deny(`denied by SHELL_DENY_PREFIXES: ${prefix.join(' ')}`);
    }
  }

  // git: explicit allowlist of read-only subcommands; everything else denied.
  if (argv0 === 'git') {
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === '-c') {
        const kv = expand(args[i + 1] ?? '', ctx.vars);
        if (/!|core\.(pager|sshCommand|fsmonitor)|credential|http\.|protocol\.|diff\.|filter\./i.test(kv)) {
          return deny(`git -c config override rejected: ${kv.split('=')[0]}`);
        }
        i += 2;
        continue;
      }
      if (a === '-C') { i += 2; continue; }
      if (/^-/.test(a)) { i++; continue; }
      break;
    }
    const sub = args[i] === undefined ? undefined : expand(args[i]!, ctx.vars);
    if (sub === undefined) return ALLOW;
    if (sub.includes('$X')) return deny('git subcommand is dynamic');
    if (!GIT_ALLOW.has(sub)) {
      return deny(`git ${sub} — shell git is read-only; the GitHub agent owns remote state`);
    }
    // Remaining args still get the generic path scan below.
  }

  if (FORBIDDEN_ARGV0.has(argv0)) return deny(`${argv0} is denied by shell policy`);

  if (ENV_DUMPERS.has(argv0)) {
    // `export FOO=1` records the var; bare set/declare/compgen dump the env.
    if (!args.length) return deny(`bare ${argv0} dumps the environment`);
    for (const a of args) {
      const am = ASSIGN.exec(a);
      if (am) ctx.vars.set(am[1]!, expand(am[2]!, ctx.vars));
    }
    return ALLOW;
  }

  if (PUBLISHERS.has(argv0) && args.some((a) => PUBLISH_SUB.has(expand(a, ctx.vars)))) {
    return deny(`registry publish/login verbs are denied (${argv0})`);
  }

  if (INLINE_EVAL.has(argv0) && args.some((a) => INLINE_FLAGS.has(a))) {
    return deny(`inline eval (${argv0} -e/-c) is unvettable — write a script file instead`);
  }

  if (SHELLS.has(argv0)) {
    const ci = args.findIndex((a) => a === '-c');
    if (ci !== -1) {
      const inner = args[ci + 1];
      if (!inner) return deny(`${argv0} -c with no script`);
      return assessShellCommand(expand(inner, ctx.vars), { root: ctx.root, env: ctx.env });
    }
    if (!args.length) return deny(`bare ${argv0} reads a script from stdin`);
    // `sh script.sh` — generic path scan below vets the script location.
  }

  for (const a of args) {
    if (FORBIDDEN_ANYWHERE.has(a)) return deny(`dangerous flag: ${a}`);
  }

  // cd stays inside the workspace.
  if (argv0 === 'cd') {
    const dest = args.find((a) => !a.startsWith('-'));
    if (!dest) return ALLOW;
    return pathVerdict(ctx.root, dest, ctx.vars);
  }

  // rm targets stay inside the workspace.
  if (argv0 === 'rm') {
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      const v = pathVerdict(ctx.root, a, ctx.vars);
      if (v.decision === 'deny') return deny(`rm ${v.reason}`);
    }
    return ALLOW;
  }

  // Generic path-arg scan: any arg that looks like a path must be inside the
  // workspace and not a protected file (.git/**, .env*, keys, /etc, ...).
  // Unresolved vars expand to '' in the real shell — harmless in non-path
  // args — so they only trip the gate when the expanded arg is pathy.
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const e = expand(a, ctx.vars);
    const looksPathy = e.includes('/') || e.startsWith('.') || e.startsWith('~');
    if (!looksPathy) continue;
    const v = pathVerdict(ctx.root, a, ctx.vars);
    if (v.decision === 'deny') return v;
  }

  return ALLOW;
}
