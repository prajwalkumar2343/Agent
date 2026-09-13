/**
 * Grader check expressions — a small DSL so dataset.jsonl stays readable:
 *
 *   tool_called('delegate_to_github') AND gh_state('pr_created')
 *   tool_call_count('*') <= 8 AND NOT loop_detected()
 *   tool_order('runShell', 'delegate_to_github')
 *   tool_args_match('delegate_to_vm_coder', {"task": {"contains": "feat_"}})
 *   file_contains('src/app.js', /feat_\w+/) OR output_contains('flag')
 *
 * Grammar: OR/AND/NOT (+ ||, &&, !) over comparisons (==, !=, <, <=, >, >=, =~)
 * over function calls / literals. Literals: 'str', "str", 123, true, /regex/i,
 * and {…} objects (JSON; unquoted keys tolerated).
 */

export type Value = string | number | boolean | RegExp | Record<string, unknown>;
export type Builtin = (ctx: unknown, ...args: Value[]) => Value;
export type Builtins = Record<string, Builtin>;

// ---------- tokenizer ----------

type Tok =
  | { t: 'lparen' | 'rparen' | 'comma' }
  | { t: 'op'; op: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'regex'; v: RegExp }
  | { t: 'obj'; v: Record<string, unknown> }
  | { t: 'ident'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isId = (c: string) => /[A-Za-z0-9_.]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ t: 'comma' });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '=~', '&&', '||'].includes(two)) {
      toks.push({ t: 'op', op: two });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>') {
      toks.push({ t: 'op', op: c });
      i++;
      continue;
    }
    if (c === '!') {
      toks.push({ t: 'op', op: '!' });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++]!;
        }
      }
      if (j >= src.length) throw new Error(`unterminated string in check: ${src}`);
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const last = toks[toks.length - 1];
      const operandPos = !last || ['lparen', 'comma'].includes(last.t) || last.t === 'op';
      if (operandPos) {
        let j = i + 1;
        let s = '';
        while (j < src.length && src[j] !== '/') {
          if (src[j] === '\\' && j + 1 < src.length) {
            s += src[j]! + src[j + 1]!;
            j += 2;
          } else {
            s += src[j++]!;
          }
        }
        if (j >= src.length) throw new Error(`unterminated regex in check: ${src}`);
        let flags = '';
        j++;
        while (j < src.length && /[a-z]/.test(src[j]!)) flags += src[j++];
        toks.push({ t: 'regex', v: new RegExp(s, flags) });
        i = j;
        continue;
      }
      throw new Error(`unexpected '/' in check: ${src}`);
    }
    if (c === '{') {
      let depth = 0;
      let j = i;
      let inStr = false;
      let q = '';
      while (j < src.length) {
        const ch = src[j]!;
        if (inStr) {
          if (ch === q && src[j - 1] !== '\\') inStr = false;
        } else if (ch === "'" || ch === '"') {
          inStr = true;
          q = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      const raw = src.slice(i, j);
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // tolerate single quotes + bare keys for hand-written specs
        const fixed = raw
          .replace(/'([^']*)'/g, '"$1"')
          .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
        obj = JSON.parse(fixed) as Record<string, unknown>;
      }
      toks.push({ t: 'obj', v: obj });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (m) {
        toks.push({ t: 'num', v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    if (isId(c)) {
      let j = i;
      while (j < src.length && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      if (/^(AND|OR|NOT)$/i.test(word)) {
        toks.push({ t: 'op', op: word.toUpperCase() });
      } else if (word === 'true' || word === 'false') {
        toks.push({ t: 'bool', v: word === 'true' });
      } else {
        toks.push({ t: 'ident', v: word });
      }
      i = j;
      continue;
    }
    throw new Error(`unexpected character '${c}' in check: ${src}`);
  }
  return toks;
}

// ---------- parser (recursive descent) ----------

type Node =
  | { kind: 'lit'; v: Value }
  | { kind: 'call'; name: string; args: Value[] }
  | { kind: 'cmp'; op: string; l: Node; r: Node }
  | { kind: 'and' | 'or'; items: Node[] }
  | { kind: 'not'; item: Node };

export function parseCheck(src: string): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseExpr(): Node {
    return parseOr();
  }
  function parseOr(): Node {
    const items = [parseAnd()];
    while (peek()?.t === 'op' && ['OR', '||'].includes((peek() as { op: string }).op)) {
      next();
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0]! : { kind: 'or', items };
  }
  function parseAnd(): Node {
    const items = [parseUnary()];
    while (peek()?.t === 'op' && ['AND', '&&'].includes((peek() as { op: string }).op)) {
      next();
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0]! : { kind: 'and', items };
  }
  function parseUnary(): Node {
    const t = peek();
    if (t?.t === 'op' && ['NOT', '!'].includes(t.op)) {
      next();
      return { kind: 'not', item: parseUnary() };
    }
    return parseComparison();
  }
  function parseComparison(): Node {
    const l = parseOperand();
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '<=', '>=', '<', '>', '=~'].includes(t.op)) {
      next();
      return { kind: 'cmp', op: t.op, l, r: parseOperand() };
    }
    return l;
  }
  function parseOperand(): Node {
    const t = next();
    if (!t) throw new Error(`unexpected end of check: ${src}`);
    if (t.t === 'lparen') {
      const e = parseExpr();
      const c = next();
      if (c?.t !== 'rparen') throw new Error(`missing ')' in check: ${src}`);
      return e;
    }
    if (t.t === 'str' || t.t === 'num' || t.t === 'bool' || t.t === 'regex' || t.t === 'obj') {
      return { kind: 'lit', v: t.v as Value };
    }
    if (t.t === 'ident') {
      const p = next();
      if (p?.t !== 'lparen') throw new Error(`expected '(' after ${t.v} in check: ${src}`);
      const args: Value[] = [];
      while (true) {
        const at = peek();
        if (at?.t === 'rparen') {
          next();
          break;
        }
        const a = parseOperand();
        if (a.kind !== 'lit') throw new Error(`call args must be literals in check: ${src}`);
        args.push(a.v);
        const sep = next();
        if (sep?.t === 'comma') continue;
        if (sep?.t === 'rparen') break;
        throw new Error(`expected ',' or ')' in check: ${src}`);
      }
      return { kind: 'call', name: t.v, args };
    }
    throw new Error(`unexpected token in check: ${src}`);
  }

  const root = parseExpr();
  if (pos !== toks.length) throw new Error(`trailing tokens in check: ${src}`);
  return root;
}

// ---------- evaluator ----------

function cmp(op: string, l: Value, r: Value): boolean {
  if (op === '=~') {
    const re = r instanceof RegExp ? r : new RegExp(String(r));
    return re.test(String(l));
  }
  if (op === '==' || op === '!=') {
    const eq = l instanceof RegExp ? l.test(String(r)) : JSON.stringify(l) === JSON.stringify(r) || l === r;
    return op === '==' ? eq : !eq;
  }
  const ln = Number(l);
  const rn = Number(r);
  switch (op) {
    case '<':
      return ln < rn;
    case '<=':
      return ln <= rn;
    case '>':
      return ln > rn;
    case '>=':
      return ln >= rn;
  }
  throw new Error(`unknown operator ${op}`);
}

export function evalCheck(node: Node, ctx: unknown, builtins: Builtins): Value {
  switch (node.kind) {
    case 'lit':
      return node.v;
    case 'call': {
      const fn = builtins[node.name];
      if (!fn) {
        throw new Error(
          `unknown grader '${node.name}' — known: ${Object.keys(builtins).sort().join(', ')}`,
        );
      }
      return fn(ctx, ...node.args);
    }
    case 'cmp':
      return cmp(node.op, evalCheck(node.l, ctx, builtins), evalCheck(node.r, ctx, builtins));
    case 'and':
      return node.items.every((i) => truthy(evalCheck(i, ctx, builtins)));
    case 'or':
      return node.items.some((i) => truthy(evalCheck(i, ctx, builtins)));
    case 'not':
      return !truthy(evalCheck(node.item, ctx, builtins));
  }
}

function truthy(v: Value): boolean {
  if (v instanceof RegExp) return true;
  if (typeof v === 'object' && v !== null) return true;
  return Boolean(v);
}

/** Parse + evaluate one check string against a context. */
export function runCheck(check: string, ctx: unknown, builtins: Builtins): boolean {
  return truthy(evalCheck(parseCheck(check), ctx, builtins));
}
