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
        if (tq === "'") { if (t === tq) tq = null; else target += t; j++; continue; }
        if (t === '`' || (t === '$' && cmd[j + 1] === '(')) {
          const [inner, next] = captureSubshell(cmd, j);
          if (inner === null) { out.unparseable = true; return out; }
          out.subshells.push(inner);
          target += '$X';
          j = next + 1;
          continue;
        }
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
const PUBLISH_SUB = new Set(['publish', 'adduser', 'login', 'logout', 'deploy', 'token', 'owner', 'access', 'push', 'upload']);
const INLINE_EVAL = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'php']);
/**
 * Flags that make each interpreter execute inline code — per interpreter so
 * shared letters don't over-deny (node -r preloads a module, python -E only
 * ignores env vars). Bundled flags (-pe, -ne, -ic) are matched separately.
 */
const INLINE_FLAGS: Record<string, ReadonlySet<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  ruby: new Set(['-e', '-p', '-n']),
  perl: new Set(['-e', '-E']),
  php: new Set(['-r', '-R', '-B']),
};
/**
 * Interpreter option flags that consume an operand which is not the program
 * (module, warning spec, ini path). The operand is vetted as a path; it is
 * consumed so that whatever remains is the script — none left means stdin.
 */
const INTERPRETER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  node: new Set([
    '-r', '--require', '--import', '--loader', '--experimental-loader',
    '--input-type', '--cpu-prof-dir', '--diagnostic-dir', '--heap-prof-dir',
    '--redirect-warnings',
  ]),
  python: new Set(['-W', '-X']),
  python3: new Set(['-W', '-X']),
  ruby: new Set(['-r', '-I', '-C']),
  perl: new Set(['-M', '-m', '-I']),
  php: new Set(['-d', '-c', '-b', '--define', '--ini']),
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'csh', 'ksh', 'ash']);
/** Shell option flags that consume a name operand (not the script). */
const SHELL_NAME_FLAGS = new Set(['-o', '-O', '--emulate']);
/** Shell option flags whose operand is itself a file the shell sources. */
const SHELL_FILE_FLAGS = new Set(['--init-file', '--rcfile']);
const WRAPPERS = new Set(['nice', 'nohup', 'timeout', 'time', 'watch', 'stdbuf', 'taskset', 'chrt', 'ionice', 'env', 'command', 'builtin']);
const ENV_DUMPERS = new Set(['set', 'declare', 'compgen', 'export', 'typeset']);
const FORBIDDEN_ANYWHERE = new Set(['-exec', '-execdir', '-delete', '--no-preserve-root']);
/** Wrapper flags that carry a separate operand, per wrapper (nice -n 5, watch -n 2). */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  time: new Set(['-f', '-o', '--format', '--output']),
  watch: new Set(['-n', '--interval']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  taskset: new Set(['-c', '--cpu-list']),
  chrt: new Set([
    '-f', '-r', '-o', '-b', '-i', '-d', '-p', '-T', '-P', '-D',
    '--fifo', '--rr', '--other', '--batch', '--idle', '--deadline', '--pid',
    '--sched-runtime', '--sched-deadline', '--sched-period',
  ]),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata', '--pid']),
};

const basename = (argv0: string) => argv0.split('/').pop() ?? argv0;

/**
 * Position of `letter` in a single-dash flag bundle (-ec), or -1 when it is
 * absent — or when an earlier o/O consumed it as an operand (bash -oc sets
 * an option named 'c', it does not mean -c).
 */
const bundleIndex = (arg: string, letter: string): number => {
  const m = /^-([a-zA-Z]+)$/.exec(arg);
  if (!m) return -1;
  const at = m[1]!.indexOf(letter);
  if (at === -1) return -1;
  return /[oO]/.test(m[1]!.slice(0, at)) ? -1 : at;
};

/** Glob/brace metacharacters — expansion results can't be vetted. */
const GLOB_META = /[*?[\]{}]/;

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
  const base = root.endsWith('/') ? root : `${root}/`;
  if (DEV_NULL.test(t)) return ALLOW;
  if (t.includes('$X')) return deny(`unresolvable variable in path position: ${token}`);
  // A URL in path position is remote code/data, not a workspace file.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return deny(`URL in path position: ${t}`);
  if (GLOB_META.test(t)) return deny(`shell metacharacters in path: ${t}`);
  if (PROTECTED_FILE.test(t)) return deny(`protected path: ${t}`);
  if (t.startsWith('~')) return deny(`home-relative path: ${t}`);
  if (t.startsWith('/')) {
    return t === root || t.startsWith(base) ? ALLOW : deny(`absolute path outside workspace: ${t}`);
  }
  if (t.includes('..')) {
    const resolved = resolveRel(root, t);
    if (resolved !== root && !resolved.startsWith(base)) {
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
  opts: { root: string; env?: NodeJS.ProcessEnv; vars?: Vars },
): ShellVerdict {
  const ctx: Ctx = {
    root: opts.root.replace(/\/+$/, '') || '/',
    env: opts.env ?? process.env,
    vars: new Map(opts.vars),
  };
  const l = lex(cmd);
  if (l.unparseable) return deny('unparseable shell syntax — refusing to vet what we cannot see');

  // Seed the var table from leading VAR=value assignments so subshells and
  // redirects are vetted against the same expansions the segments will set.
  for (const seg of l.segments) {
    for (const t of tokenize(seg)) {
      const m = ASSIGN.exec(t);
      if (!m) break;
      ctx.vars.set(m[1]!, m[2]!);
    }
  }

  for (const sub of l.subshells) {
    const v = assessShellCommand(sub, { root: ctx.root, env: ctx.env, vars: ctx.vars });
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
    // env -S carries the whole command line — when it does, "nothing left"
    // afterwards is not a bare env invocation.
    let envSplitCmd = false;
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
        if (WRAPPER_VALUE_FLAGS[w]?.has(a) && tokens.length) {
          const operand = tokens[0]!;
          // Operands that are paths or command strings are vetted as if
          // written directly: env -C dir and time -o file are paths;
          // env -S is a whole command line that re-enters the assessor.
          if (w === 'env' && (a === '-C' || a === '--chdir')) {
            const v = pathVerdict(ctx.root, operand, ctx.vars);
            if (v.decision === 'deny') return deny(`env ${a} ${v.reason}`);
          } else if (w === 'env' && (a === '-S' || a === '--split-string')) {
            const v = assessShellCommand(expand(operand, ctx.vars), { root: ctx.root, env: ctx.env });
            if (v.decision === 'deny') return deny(`env ${a} ${v.reason}`);
            envSplitCmd = true;
          } else if (w === 'time' && (a === '-o' || a === '--output')) {
            const v = pathVerdict(ctx.root, operand, ctx.vars);
            if (v.decision === 'deny') return deny(`time ${a} ${v.reason}`);
          }
          tokens = tokens.slice(1);
        }
        continue;
      }
      // timeout's positional duration operand.
      if (w === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(a)) {
        tokens = tokens.slice(1);
        continue;
      }
      break;
    }
    if (!tokens.length) {
      if (w === 'env' && envSplitCmd) return ALLOW;
      return deny(`bare '${w}' — env-dumping / no-op wrappers are denied`);
    }
  }

  const argv0raw = expand(tokens[0]!, ctx.vars);
  const args = tokens.slice(1);

  if (argv0raw.includes('$X') || argv0raw.startsWith('$')) {
    return deny('command name is a variable/expansion — refusing to vet');
  }

  // An argv0 that looks like a path (/, .., ~, glob meta) is a file the
  // policy must see — basename() alone would smuggle ../x.sh or /tmp/x.sh
  // past every rule. Vet it like a path arg, then take the basename.
  if (/[/~]/.test(argv0raw) || argv0raw.includes('..') || GLOB_META.test(argv0raw)) {
    const v = pathVerdict(ctx.root, argv0raw, ctx.vars);
    if (v.decision === 'deny') return deny(`command path ${v.reason}`);
  }
  const argv0 = basename(argv0raw);

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
      if (a === '-C') {
        // -C relocates git before it acts — the directory is vetted like a
        // path arg so read-only subcommands can't be pointed outside the
        // workspace or into protected dirs.
        const dir = args[i + 1];
        if (dir !== undefined) {
          const v = pathVerdict(ctx.root, dir, ctx.vars);
          if (v.decision === 'deny') return deny(`git -C ${v.reason}`);
        }
        i += 2;
        continue;
      }
      if (/^-/.test(a)) { i++; continue; }
      break;
    }
    const sub = args[i] === undefined ? undefined : expand(args[i]!, ctx.vars);
    if (sub === undefined) return ALLOW;
    if (sub.includes('$X')) return deny('git subcommand is dynamic');
    if (!GIT_ALLOW.has(sub)) {
      return deny(`git ${sub} — shell git is read-only; the GitHub agent owns remote state`);
    }
    // rev:path args (git show HEAD:.env, :0:.env) name files the path scan
    // can't see — vet the tail of every ':'-bearing arg.
    for (const a of args.slice(i + 1)) {
      if (a.startsWith('-')) continue;
      const colon = a.lastIndexOf(':');
      if (colon === -1) continue;
      const v = pathVerdict(ctx.root, a.slice(colon + 1), ctx.vars);
      if (v.decision === 'deny') return deny(`git ${v.reason}`);
    }
    // Remaining args still get the generic path scan below.
  }

  if (FORBIDDEN_ARGV0.has(argv0)) return deny(`${argv0} is denied by shell policy`);

  if (ENV_DUMPERS.has(argv0)) {
    // Only `export FOO=1`-style assignments are allowed — bare invocations
    // and flags (export -p, declare -p, compgen -e, set -o) dump or probe
    // the environment.
    if (!args.length) return deny(`bare ${argv0} dumps the environment`);
    for (const a of args) {
      const am = ASSIGN.exec(a);
      if (!am) return deny(`${argv0} ${a} — only VAR=value assignments are allowed`);
      ctx.vars.set(am[1]!, expand(am[2]!, ctx.vars));
    }
    return ALLOW;
  }

  if (PUBLISHERS.has(argv0) && args.some((a) => PUBLISH_SUB.has(expand(a, ctx.vars)))) {
    return deny(`registry publish/login verbs are denied (${argv0})`);
  }

  if (INLINE_EVAL.has(argv0)) {
    const expanded = args.map((a) => expand(a, ctx.vars));
    const bundles = argv0 === 'perl' || argv0 === 'ruby' || argv0 === 'node';
    const inlineFlags = INLINE_FLAGS[argv0];
    const inline = expanded.some(
      (a) =>
        (inlineFlags?.has(a) ?? false) ||
        (bundles && /^-[a-zA-Z]*[eE]/.test(a)) ||
        ((argv0 === 'python' || argv0 === 'python3') && /^-[a-zA-Z]*c/.test(a)) ||
        (argv0 === 'php' && /^-[rRB]/.test(a)) ||
        // deno: `eval` runs inline code; `-` (deno run -, deno fmt -) reads stdin.
        (argv0 === 'deno' && (a === 'eval' || a === '-')),
    );
    if (inline) {
      return deny(`inline eval via ${argv0} is unvettable — write a script file instead`);
    }
    // Find the program operand: option flags that consume their own operand
    // have it vetted as a path. No operand left means the interpreter reads
    // its program from stdin — unvettable (node -r cfg, python -W ignore,
    // node -, deno run - all qualify).
    const valueFlags = INTERPRETER_VALUE_FLAGS[argv0];
    let hasProgram = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const e = expanded[i]!;
      if (e.includes('$X')) return deny(`unresolvable variable in ${argv0} arguments`);
      if (a === '--') { hasProgram = i + 1 < args.length; break; }
      if (!e.startsWith('-')) { hasProgram = true; break; }
      // python -m<module> attached form runs a module — that is the program.
      if ((argv0 === 'python' || argv0 === 'python3') && /^-m./.test(e)) {
        hasProgram = true;
        break;
      }
      if (valueFlags?.has(e) && i + 1 < args.length) {
        const operand = args[++i]!;
        // key=value operands (php -d auto_prepend_file=..., --define) hide
        // the path on the right of '=' — vet that side.
        const eq = operand.indexOf('=');
        const v = pathVerdict(ctx.root, eq === -1 ? operand : operand.slice(eq + 1), ctx.vars);
        if (v.decision === 'deny') return deny(`${argv0} ${a} ${v.reason}`);
      }
    }
    if (!hasProgram) {
      return deny(`${argv0} with no script operand reads a program from stdin`);
    }
  }

  if (SHELLS.has(argv0)) {
    // Options are scanned until the first operand. -c (possibly bundled:
    // sh -ec …) takes the next arg as a command string — recurse into it.
    // '-' and -s read the program from stdin, which cannot be vetted — and
    // with no operand at all the shell reads stdin too. The first operand
    // is otherwise the script file and is vetted as a path.
    let script: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--') { script = args[i + 1]; break; }
      if (!a.startsWith('-')) { script = a; break; }
      if (a === '-') return deny(`${argv0} - reads a script from stdin`);
      if (
        bundleIndex(a, 'c') !== -1 ||
        (argv0 === 'fish' && (bundleIndex(a, 'C') !== -1 || a === '--command'))
      ) {
        const inner = args[i + 1];
        if (!inner) return deny(`${argv0} -c with no script`);
        return assessShellCommand(expand(inner, ctx.vars), { root: ctx.root, env: ctx.env });
      }
      if (bundleIndex(a, 's') !== -1) return deny(`${argv0} ${a} reads a script from stdin`);
      // Bundles ending in o/O (bash -eo pipefail) and named-option flags
      // consume their own operand — it is not the script.
      if (/^-[a-zA-Z]+[oO]$/.test(a) || SHELL_NAME_FLAGS.has(a)) { i++; continue; }
      // Option flags whose operand is a sourced file get the path vetting —
      // both separated (--init-file f) and attached (--init-file=f) forms;
      // the attached form must be caught here because -c above returns
      // before the generic path scan runs.
      const eq = a.indexOf('=');
      if (SHELL_FILE_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
        const operand = eq === -1 ? args[i + 1] : a.slice(eq + 1);
        if (operand !== undefined) {
          const v = pathVerdict(ctx.root, operand, ctx.vars);
          if (v.decision === 'deny') return deny(`${argv0} ${a} ${v.reason}`);
        }
        if (eq === -1) i++;
      }
    }
    if (script === undefined) {
      return deny(`${argv0} with no script operand reads a script from stdin`);
    }
    const sv = pathVerdict(ctx.root, script, ctx.vars);
    if (sv.decision === 'deny') return deny(`${argv0} script ${sv.reason}`);
    // `sh script.sh` — the generic path scan below vets the remaining args.
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
    let target = a;
    if (a.startsWith('-')) {
      // --opt=val / -o=val carry a value after '='; attached short-flag
      // operands (-o/path, -cf.env) start at the first path-like char.
      const eq = a.indexOf('=');
      if (eq !== -1) {
        target = a.slice(eq + 1);
      } else {
        const p = a.search(/[/.~]/);
        if (p === -1) continue;
        target = a.slice(p);
      }
    }
    const e = expand(target, ctx.vars);
    const looksPathy = e.includes('/') || e.startsWith('.') || e.startsWith('~') || GLOB_META.test(e);
    if (!looksPathy) continue;
    const v = pathVerdict(ctx.root, target, ctx.vars);
    if (v.decision === 'deny') return v;
  }

  return ALLOW;
}
