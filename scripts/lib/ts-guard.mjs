// TypeScript fitness guard (exit criteria E8/G3).
//
// A regex over source text cannot tell a declaration from a use, and it is
// blind to an alias, a computed property name or an object spread — the
// review's exact objection to the previous isolation-waiver rule. This guard
// asks the TypeScript checker instead (the TS 7 API in `typescript/unstable/
// sync`): it loads every package project, walks the shipped source, and
// resolves names, types and constant strings the way the compiler does.
//
// Rules
//
//   retired-isolation-waiver  The sandbox / host-execution waivers are gone.
//     Their identifiers, and string values that constant-fold to their tokens
//     (through `+`, template literals, `as const`, and const aliases across
//     modules), may not reappear in shipped source.
//
//   isolation-claim  Only adapters/command-runner/src/sandbox.ts may produce a
//     value that claims `isolationEnforced` is anything but `false`. Checked by
//     type, not by spelling: an object literal whose TYPE carries the claim
//     (literal property, shorthand, const alias, computed key the checker or the
//     folder resolves, spread), an unresolvable computed key in an object that
//     is typed to carry the claim, an assignment or element write, the
//     Object.assign / Object.defineProperty / Reflect.set / Reflect.defineProperty
//     family, a class member of that name, a string carrying the property name,
//     a type assertion that pins a claim-carrying type onto a value that does not
//     have it, and an `any` flowing into a claim-typed position.
//
//   persistence-call-in-root  A composition root (apps/*, workers/*) wires the
//     persistence adapter and hands it to application use cases; it never
//     invokes it. Any call whose target is declared in adapters/persistence is
//     refused — resolved by symbol and by type, so the variable's name does not
//     matter, and a destructured method, `.call` / `.apply` / `.bind`, or an
//     element access is seen through. Construction (`new X(...)`) is not a call,
//     and opening, migrating and pinging the database (PERSISTENCE_BOOTSTRAP)
//     are the sanctioned uses.
//
//   port-call-in-root  The same call with the adapter's type laundered through
//     a port: a root may not invoke a member of an interface declared in
//     packages/application or packages/ports. Ports are driven by use cases.
//     A value retyped through an interface the root declares itself is beyond
//     what a static check can follow.
//
// The guard is a static net, not a proof: a value built at run time from
// arbitrary computation can still evade it. It closes the shapes that are
// cheap to write by accident or on purpose, and the runtime refusal of any
// handle that does not claim isolation stays the enforcement point.

import { readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { API, TypeFlags, SymbolFlags } from 'typescript/unstable/sync';
import { SyntaxKind, NodeFlags } from 'typescript/unstable/ast';

export const CLAIM = 'isolationEnforced';
export const CLAIM_ALLOWED_FILES = Object.freeze(['adapters/command-runner/src/sandbox.ts']);

// Waiver vocabulary that no longer exists anywhere in the product.
export const RETIRED_TOKENS = Object.freeze([
  'waived-pilot-only', 'pilot-unsandboxed', 'pilot-only-no-agent-isolation', 'ASEP_SANDBOX_MODE',
]);
export const RETIRED_IDENTIFIERS = Object.freeze([
  'hostExecutionWaiver', 'HOST_EXECUTION_WAIVER', 'sandboxRequirement', 'SandboxRequirement',
  'resolveSandboxRequirement', 'assertSandboxSatisfiesRequirement', 'SandboxRequiredError',
  'ASEP_SANDBOX_MODE',
]);

export const PROJECT_DIRS = Object.freeze(['packages', 'adapters', 'apps', 'workers']);

// The persistence calls a composition root may make itself: opening the
// database, bringing its schema up to date, and probing the connection for
// readiness. Everything else is reached through an application use case.
export const PERSISTENCE_BOOTSTRAP = Object.freeze([
  'migrate', 'PgPoolClient.fromPool', 'PgliteClient.create',
  'PgPoolClient.ping', 'PgliteClient.ping', 'SqlClient.ping',
]);
const PERSISTENCE_SOURCE = /\/adapters\/persistence\/(src|dist)\//;
const PORT_SOURCE = /\/packages\/(application|ports)\/(src|dist)\//;

/** Shipped TypeScript: package src, not tests, not declarations. */
export function isShippedSource(rel) {
  return /^(packages|adapters|apps|workers)\/[^/]+\/src\/.+\.ts$/.test(rel) &&
    !/\.(test|itest|live)\.ts$/.test(rel) && !rel.endsWith('.d.ts');
}

/** Shipped source of a composition root (apps/*, workers/*). */
export function isCompositionRoot(rel) {
  return /^(apps|workers)\//.test(rel) && isShippedSource(rel);
}

export function discoverProjects(root) {
  const out = [];
  for (const base of PROJECT_DIRS) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const cfg = join(dir, name, 'tsconfig.json');
      if (existsSync(cfg)) out.push(cfg);
    }
  }
  return out;
}

// A virtual overlay over the real filesystem, so fixtures can be checked
// inside a real project (with its real imports) without touching the disk.
function overlayFs(overlay) {
  const byLower = new Map(Object.entries(overlay).map(([k, v]) => [k.toLowerCase(), v]));
  if (byLower.size === 0) return undefined;
  const dirs = new Map();
  for (const k of Object.keys(overlay)) {
    const d = dirname(k).toLowerCase();
    dirs.set(d, [...(dirs.get(d) ?? []), basename(k)]);
  }
  return {
    readFile: (p) => byLower.get(p.toLowerCase()),
    fileExists: (p) => (byLower.has(p.toLowerCase()) ? true : undefined),
    getAccessibleEntries: (d) => {
      const extra = dirs.get(d.toLowerCase());
      if (!extra) return undefined;
      const files = [];
      const directories = [];
      for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? directories : files).push(e.name);
      return { files: [...files, ...extra], directories };
    },
  };
}

/**
 * Run every rule over the shipped source of the given projects (or the files
 * `include` selects). Returns the violations and how many files were checked.
 */
export function runGuard({
  root, overlay = {}, include = isShippedSource, projects = discoverProjects(root),
  claimAllowed = CLAIM_ALLOWED_FILES,
}) {
  const fs = overlayFs(overlay);
  const api = new API({ cwd: root, ...(fs ? { fs } : {}) });
  try {
    const snap = api.updateSnapshot({ openProjects: projects });
    const violations = [];
    const checked = new Set();
    const rootLower = root.toLowerCase();
    for (const cfg of projects) {
      const project = snap.getProject(cfg);
      if (!project) throw new Error(`ts-guard: project ${cfg} did not load`);
      const own = `${dirname(cfg).toLowerCase()}/`;
      for (const fileName of project.program.getSourceFileNames()) {
        const lower = fileName.toLowerCase();
        if (!lower.startsWith(own) || !lower.startsWith(`${rootLower}/`)) continue;
        const rel = fileName.slice(root.length + 1).split('\\').join('/');
        if (!include(rel) || checked.has(rel)) continue;
        checked.add(rel);
        const sf = project.program.getSourceFile(fileName);
        if (!sf) throw new Error(`ts-guard: ${rel} has no source file`);
        violations.push(...new FileCheck(project, sf, rel, claimAllowed.includes(rel)).run());
      }
    }
    return { violations, filesChecked: checked.size };
  } finally {
    api.close();
  }
}

const STRING_BUILDERS = new Set([
  SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateExpression,
]);
const WRAPPERS = new Set([
  SyntaxKind.ParenthesizedExpression, SyntaxKind.AsExpression, SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression, SyntaxKind.TypeAssertionExpression,
]);
const ASSIGNMENT_OPS = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);
const CLASS_MEMBERS = new Set([
  SyntaxKind.PropertyDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.MethodDeclaration,
]);
const REFLECTIVE = new Map([
  ['ObjectConstructor', new Set(['assign', 'defineProperty', 'defineProperties'])],
  ['Reflect', new Set(['set', 'defineProperty'])],
]);

class FileCheck {
  constructor(project, sf, rel, claimsAllowed) {
    this.claimsAllowed = claimsAllowed;
    this.project = project;
    this.checker = project.checker;
    this.sf = sf;
    this.rel = rel;
    this.out = [];
    this.seen = new Set();
    this.types = new Map();
    this.symbols = new Map();
  }

  run() {
    const nodes = {
      identifiers: [], strings: [], objects: [], assignments: [], calls: [], members: [], casts: [], flows: [],
    };
    const visit = (n) => {
      switch (n.kind) {
        case SyntaxKind.Identifier:
        case SyntaxKind.PrivateIdentifier:
          nodes.identifiers.push(n);
          break;
        case SyntaxKind.ObjectLiteralExpression:
          nodes.objects.push(n);
          break;
        case SyntaxKind.BinaryExpression:
          if (n.operatorToken.kind === SyntaxKind.PlusToken) nodes.strings.push(n);
          else if (ASSIGNMENT_OPS.has(n.operatorToken.kind)) nodes.assignments.push(n);
          break;
        case SyntaxKind.CallExpression:
          nodes.calls.push(n);
          break;
        case SyntaxKind.AsExpression:
        case SyntaxKind.TypeAssertionExpression:
          nodes.casts.push(n);
          break;
        case SyntaxKind.VariableDeclaration:
          if (n.initializer) nodes.flows.push(n.initializer);
          break;
        case SyntaxKind.ReturnStatement:
          if (n.expression) nodes.flows.push(n.expression);
          break;
        default:
          // A string in a TYPE (`Pick<T, 'x'>`) is not a value.
          if (STRING_BUILDERS.has(n.kind) && n.parent?.kind !== SyntaxKind.LiteralType) nodes.strings.push(n);
          if (CLASS_MEMBERS.has(n.kind) && n.parent &&
            (n.parent.kind === SyntaxKind.ClassDeclaration || n.parent.kind === SyntaxKind.ClassExpression)) {
            nodes.members.push(n);
          }
      }
      n.forEachChild(visit);
    };
    this.sf.forEachChild(visit);

    this.retiredVocabulary(nodes);
    if (!this.claimsAllowed) this.isolationClaims(nodes);
    if (isCompositionRoot(this.rel)) this.persistenceCalls(nodes.calls);
    return this.out;
  }

  // --- reporting ---------------------------------------------------------

  report(rule, node, message) {
    const line = this.lineOf(node);
    const key = `${rule}:${line}:${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push({ rule, file: this.rel, line, message });
  }

  lineOf(node) {
    const text = this.sf.text;
    let i = node.pos;
    // Skip leading trivia so the line is the node's own, not a comment above it.
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) i = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
      else if (text.startsWith('/*', i)) i = text.indexOf('*/', i) < 0 ? text.length : text.indexOf('*/', i) + 2;
      else break;
    }
    let line = 1;
    for (let k = 0; k < i && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
    return line;
  }

  // --- checker access (batched where it matters, cached always) -------------

  prefetchTypes(list) {
    const todo = list.filter((n) => !this.types.has(n));
    if (todo.length === 0) return;
    const got = this.checker.getTypeAtLocation(todo);
    todo.forEach((n, i) => this.types.set(n, got[i]));
  }

  typeOf(node) {
    if (!this.types.has(node)) this.types.set(node, this.checker.getTypeAtLocation(node));
    return this.types.get(node);
  }

  symbolOf(node) {
    if (!this.symbols.has(node)) {
      let s = this.checker.getSymbolAtLocation(node);
      if (s && (s.flags & SymbolFlags.Alias)) s = this.checker.getAliasedSymbol(s);
      this.symbols.set(node, s);
    }
    return this.symbols.get(node);
  }

  // The constant string an expression always evaluates to, or undefined.
  fold(node, depth = 0) {
    if (!node || depth > 12) return undefined;
    switch (node.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.NumericLiteral:
        return node.text;
      case SyntaxKind.TemplateExpression: {
        let s = node.head.text;
        for (const span of node.templateSpans) {
          const v = this.fold(span.expression, depth + 1);
          if (v === undefined) return undefined;
          s += v + span.literal.text;
        }
        return s;
      }
      case SyntaxKind.BinaryExpression: {
        if (node.operatorToken.kind !== SyntaxKind.PlusToken) return undefined;
        const l = this.fold(node.left, depth + 1);
        const r = l === undefined ? undefined : this.fold(node.right, depth + 1);
        return l !== undefined && r !== undefined ? l + r : undefined;
      }
      case SyntaxKind.Identifier:
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        return this.foldReference(node, depth);
      default:
        return WRAPPERS.has(node.kind) ? this.fold(node.expression, depth + 1) : undefined;
    }
  }

  foldReference(node, depth) {
    const t = this.typeOf(node);
    if (t?.isStringLiteralType?.()) return t.value;
    if (t?.isNumberLiteralType?.()) return String(t.value);
    // A const whose initializer folds (e.g. `const k = 'a' + 'b'`, typed string).
    const decl = this.symbolOf(node)?.valueDeclaration?.resolve();
    if (!decl) return undefined;
    if (decl.kind === SyntaxKind.VariableDeclaration && decl.initializer &&
      decl.parent && (decl.parent.flags & NodeFlags.Const)) {
      return this.fold(decl.initializer, depth + 1);
    }
    if (decl.kind === SyntaxKind.PropertyAssignment) return this.fold(decl.initializer, depth + 1);
    return undefined;
  }

  // The property name a name node denotes, or undefined if it cannot be known.
  nameOf(name) {
    if (!name) return undefined;
    switch (name.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.PrivateIdentifier:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return name.text;
      case SyntaxKind.ComputedPropertyName:
        return this.fold(name.expression);
      default:
        return undefined;
    }
  }

  // --- claim types -------------------------------------------------------

  // 'none' (no such property), 'false' (declared exactly false), 'claim', or
  // 'untyped' (any / unknown: it could be anything, a claim included).
  claimOf(type) {
    if (!type) return 'none';
    if (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return 'untyped';
    const members = type.isUnionType?.() || type.isIntersectionType?.() ? type.getTypes() : [type];
    let result = 'none';
    for (const m of members) {
      const prop = this.checker.getPropertyOfType(m, CLAIM);
      if (!prop) continue;
      if (this.isFalseType(this.checker.getTypeOfSymbol(prop))) {
        if (result === 'none') result = 'false';
      } else {
        result = 'claim';
      }
    }
    return result;
  }

  // Exactly `false` (optionally `| undefined`): the one value that is no claim.
  isFalseType(t) {
    if (!t) return false;
    if (t.isBooleanLiteralType?.()) return t.value === false;
    if (t.isUnionType?.()) {
      const parts = t.getTypes();
      return parts.some((p) => p.isBooleanLiteralType?.()) &&
        parts.every((p) => (p.isBooleanLiteralType?.() && p.value === false) ||
          (p.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0);
    }
    return false;
  }

  // The type declares the property at all (as a claim or as false).
  carriesClaim(type) {
    const c = this.claimOf(type);
    return c === 'claim' || c === 'false';
  }

  // A value of this type may bring a claim with it.
  mayClaim(type) {
    const c = this.claimOf(type);
    return c === 'claim' || c === 'untyped';
  }

  isFalse(node) {
    return this.isFalseType(this.typeOf(node));
  }

  // --- rule: retired waiver vocabulary --------------------------------------

  retiredVocabulary(nodes) {
    for (const id of nodes.identifiers) {
      if (RETIRED_IDENTIFIERS.includes(id.text)) {
        this.report('retired-isolation-waiver', id, `the retired waiver identifier '${id.text}' reappears`);
      }
    }
    this.prefetchTypes(this.stringLeaves(nodes.strings));
    for (const s of nodes.strings) {
      const v = this.fold(s);
      if (v === undefined) continue;
      const token = RETIRED_TOKENS.find((t) => v.includes(t)) ?? RETIRED_IDENTIFIERS.find((t) => v === t);
      if (token) this.report('retired-isolation-waiver', s, `a string constant-folds to the retired waiver token '${token}'`);
    }
  }

  stringLeaves(strings) {
    const leaves = [];
    const walk = (n) => {
      if (n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.PropertyAccessExpression ||
        n.kind === SyntaxKind.ElementAccessExpression) {
        leaves.push(n);
      } else if (n.kind === SyntaxKind.BinaryExpression) {
        walk(n.left);
        walk(n.right);
      } else if (n.kind === SyntaxKind.TemplateExpression) {
        for (const span of n.templateSpans) walk(span.expression);
      } else if (WRAPPERS.has(n.kind)) {
        walk(n.expression);
      }
    };
    for (const s of strings) walk(s);
    return leaves;
  }

  // --- rule: isolation claims -------------------------------------------------

  isolationClaims(nodes) {
    const rule = 'isolation-claim';
    for (const s of nodes.strings) {
      const v = this.fold(s);
      if (v !== undefined && v.includes(CLAIM)) {
        this.report(rule, s, `a string carries the isolation-claim property name '${CLAIM}'`);
      }
    }

    this.prefetchTypes(nodes.objects);
    for (const obj of nodes.objects) {
      if (this.claimOf(this.typeOf(obj)) === 'claim') {
        this.report(rule, obj, `an object literal claims '${CLAIM}' (only the Docker sandbox provider may)`);
      }
      const context = this.checker.getContextualType(obj);
      const typedForClaim = this.carriesClaim(context) || this.carriesClaim(this.typeOf(obj));
      for (const el of obj.properties) {
        if (el.kind === SyntaxKind.SpreadAssignment) {
          const t = this.typeOf(el.expression);
          if (this.claimOf(t) === 'claim' || (typedForClaim && this.claimOf(t) === 'untyped')) {
            this.report(rule, el, `a spread carries a '${CLAIM}' claim into an object literal`);
          }
          continue;
        }
        const name = this.nameOf(el.name);
        if (name === undefined) {
          if (typedForClaim) {
            this.report(rule, el, `a computed key that cannot be resolved, in an object typed to carry '${CLAIM}'`);
          }
          continue;
        }
        if (name !== CLAIM) continue;
        if (el.kind === SyntaxKind.PropertyAssignment) {
          if (!this.isFalse(el.initializer)) this.report(rule, el, `'${CLAIM}' is assigned a value that is not false`);
        } else if (el.kind === SyntaxKind.ShorthandPropertyAssignment) {
          if (!this.isFalse(el.name)) this.report(rule, el, `'${CLAIM}' is assigned (shorthand) a value that is not false`);
        } else {
          this.report(rule, el, `'${CLAIM}' is defined by an accessor or method`);
        }
      }
    }

    for (const a of nodes.assignments) {
      const target = a.left;
      let name;
      let receiver;
      if (target.kind === SyntaxKind.PropertyAccessExpression) {
        name = target.name.text;
        receiver = target.expression;
      } else if (target.kind === SyntaxKind.ElementAccessExpression) {
        name = this.fold(target.argumentExpression);
        receiver = target.expression;
      } else {
        continue;
      }
      if (name === CLAIM) {
        if (!this.isFalse(a.right)) this.report(rule, a, `'${CLAIM}' is written with a value that is not false`);
      } else if (name === undefined && this.carriesClaim(this.typeOf(receiver))) {
        this.report(rule, a, `an element write with an unresolvable key, on a value typed to carry '${CLAIM}'`);
      }
    }

    for (const call of nodes.calls) {
      const method = this.reflectiveMethod(call.expression);
      if (!method) continue;
      const args = call.arguments;
      if (method === 'assign') {
        for (const src of args.slice(1)) {
          if (this.mayClaim(this.typeOf(src)) && (this.claimOf(this.typeOf(src)) === 'claim' ||
            this.carriesClaim(this.typeOf(args[0])))) {
            this.report(rule, call, `Object.assign copies a '${CLAIM}' claim`);
          }
        }
      } else if (method === 'defineProperties') {
        if (this.carriesClaim(this.typeOf(args[1]))) this.report(rule, call, `Object.defineProperties defines '${CLAIM}'`);
      } else {
        const key = this.fold(args[1]);
        if (key === CLAIM) {
          this.report(rule, call, `'${CLAIM}' is defined reflectively (${method})`);
        } else if (key === undefined && args[0] && this.carriesClaim(this.typeOf(args[0]))) {
          this.report(rule, call, `a reflective ${method} with an unresolvable key, on a value typed to carry '${CLAIM}'`);
        }
      }
    }

    for (const m of nodes.members) {
      if (this.nameOf(m.name) !== CLAIM) continue;
      if (m.kind === SyntaxKind.PropertyDeclaration && m.initializer && this.isFalse(m.initializer)) continue;
      this.report(rule, m, `a class member defines '${CLAIM}'`);
    }

    this.prefetchTypes(nodes.casts);
    for (const c of nodes.casts) {
      if (!this.carriesClaim(this.typeOf(c))) continue;
      const operand = this.claimOf(this.typeOf(c.expression));
      if (operand === 'none' || operand === 'untyped') {
        this.report(rule, c, `a type assertion pins a '${CLAIM}'-carrying type onto a value that does not carry it`);
      }
    }

    this.prefetchTypes(nodes.flows);
    for (const f of nodes.flows) {
      const t = this.typeOf(f);
      if (!t || !(t.flags & TypeFlags.Any)) continue;
      if (this.carriesClaim(this.checker.getContextualType(f))) {
        this.report(rule, f, `an untyped (any) value flows into a position typed to carry '${CLAIM}'`);
      }
    }
  }

  // 'assign' | 'defineProperty' | … when the callee is that member of Object or
  // Reflect — by the callee's TYPE, so `const { assign } = Object` is caught.
  reflectiveMethod(callee) {
    const sym = this.typeOf(callee)?.getSymbol?.();
    if (!sym) return undefined;
    const owner = sym.getParent?.()?.name;
    const methods = owner ? REFLECTIVE.get(owner) : undefined;
    return methods?.has(sym.name) ? sym.name : undefined;
  }

  // --- rule: persistence calls in composition roots ------------------------

  persistenceCalls(calls) {
    const rule = 'persistence-call-in-root';
    for (const call of calls) {
      let callee = call.expression;
      while (WRAPPERS.has(callee.kind)) callee = callee.expression;
      // `fn.call(…)`, `fn.apply(…)`, `fn.bind(…)`: the target is `fn`. A bound
      // function called later (`fn.bind(x)(…)`) keeps `fn`'s type, so the type
      // check below sees through it.
      if (callee.kind === SyntaxKind.PropertyAccessExpression && ['call', 'apply', 'bind'].includes(callee.name.text)) {
        callee = callee.expression;
      }
      while (WRAPPERS.has(callee.kind)) callee = callee.expression;
      const named = callee.kind === SyntaxKind.PropertyAccessExpression ? callee.name
        : callee.kind === SyntaxKind.ElementAccessExpression ? callee.argumentExpression : callee;
      // By symbol (`repo.method`, an imported function, a member of a union of
      // adapters) and by type (a destructured or bound method, an element
      // access): either one reaching a persistence declaration is a
      // persistence call.
      const candidates = [this.symbolOf(named), this.typeOf(callee)?.getSymbol?.()].filter(Boolean);
      const target = candidates.find((s) => this.declaredIn(s, PERSISTENCE_SOURCE));
      if (target) {
        const qualified = this.qualifiedName(target);
        if (PERSISTENCE_BOOTSTRAP.includes(qualified)) continue;
        this.report(rule, call, `a composition root calls the persistence adapter directly (${qualified}); ` +
          'route it through an application use case');
        continue;
      }
      // The same call with the adapter's type laundered through a port: the
      // application drives its ports, a root only wires them.
      const port = candidates.find((s) => this.isPortMember(s));
      if (port) {
        this.report('port-call-in-root', call, `a composition root invokes the port member ${this.qualifiedName(port)} ` +
          'itself; ports are driven by application use cases');
      }
    }
  }

  qualifiedName(sym) {
    const owner = sym.getParent?.()?.name;
    return owner && owner !== sym.name && !owner.startsWith('"') ? `${owner}.${sym.name}` : sym.name;
  }

  isPortMember(sym) {
    const owner = sym.getParent?.();
    return !!owner && (owner.flags & SymbolFlags.Interface) !== 0 && this.declaredIn(sym, PORT_SOURCE);
  }

  declaredIn(sym, pattern) {
    const decls = [sym.valueDeclaration, ...(sym.declarations ?? [])].filter(Boolean);
    return decls.some((d) => pattern.test((d.path ?? d.resolve?.()?.getSourceFile?.()?.fileName ?? '').split('\\').join('/')));
  }
}
