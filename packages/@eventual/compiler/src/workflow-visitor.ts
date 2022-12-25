import {
  Argument,
  ArrowFunctionExpression,
  AwaitExpression,
  CallExpression,
  Expression,
  FunctionExpression,
  Param,
  Span,
  TsType,
  Node,
  StringLiteral,
  FunctionDeclaration,
  BlockStatement,
  VariableDeclaration,
  Statement,
  HasSpan,
} from "@swc/core";

import { Visitor } from "@swc/core/Visitor.js";

const supportedPromiseFunctions: string[] = [
  "all",
  "allSettled",
  "any",
  "race",
];

export class OuterVisitor extends Visitor {
  readonly inner = new InnerVisitor();

  public foundEventual = false;

  public visitCallExpression(call: CallExpression): Expression {
    if (isWorkflowCall(call)) {
      this.foundEventual = true;

      const [name, options, func] =
        call.arguments.length === 2
          ? [call.arguments[0], undefined, call.arguments[1]]
          : [call.arguments[0], call.arguments[1], call.arguments[2]];

      // workflow("id", async () => { .. })
      return {
        ...call,
        arguments: [
          // workflow name, e.g. "id"
          name,
          ...(options ? [options] : []),
          {
            spread: func!.spread,
            // transform the function into a generator
            // e.g. async () => { .. } becomes function*() { .. }
            expression: this.inner.visitWorkflow(
              func!.expression as ArrowFunctionExpression | FunctionExpression
            ),
          },
        ],
      };
    }
    return super.visitCallExpression(call);
  }

  public visitTsType(n: TsType): TsType {
    return n;
  }
}

export class InnerVisitor extends Visitor {
  public visitTsType(n: TsType): TsType {
    return n;
  }

  public visitWorkflow(
    workflow: FunctionExpression | ArrowFunctionExpression
  ): FunctionExpression {
    return {
      type: "FunctionExpression",
      generator: true,
      span: workflow.span,
      async: false,
      identifier:
        workflow.type === "FunctionExpression"
          ? workflow.identifier
          : undefined,
      decorators:
        workflow.type === "FunctionExpression"
          ? workflow.decorators
          : undefined,
      body: workflow.body
        ? workflow.body.type === "BlockStatement"
          ? this.visitBlockStatement(workflow.body)
          : {
              type: "BlockStatement",
              span: getSpan(workflow.body),
              stmts: [
                {
                  type: "ReturnStatement",
                  span: getSpan(workflow.body),
                  argument: this.visitExpression(workflow.body),
                },
              ],
            }
        : undefined,
      params: workflow.params.map((p) =>
        p.type === "Parameter"
          ? this.visitParameter(p)
          : {
              pat: this.visitPattern(p),
              span: getSpan(p),
              type: "Parameter",
            }
      ),
    };
  }

  public visitAwaitExpression(awaitExpr: AwaitExpression): Expression {
    return {
      type: "YieldExpression",
      delegate: false,
      span: awaitExpr.span,
      argument: this.visitExpression(awaitExpr.argument),
    };
  }

  public visitCallExpression(call: CallExpression): Expression {
    if (
      call.callee.type === "MemberExpression" &&
      call.callee.object.type === "Identifier" &&
      call.callee.object.value === "Promise" &&
      call.callee.property.type === "Identifier"
    ) {
      if (
        supportedPromiseFunctions.includes(call.callee.property.value as any)
      ) {
        call.callee.object.value = "$Eventual";
      }
    }
    return super.visitCallExpression(call);
  }

  public visitFunctionExpression(
    funcExpr: FunctionExpression
  ): FunctionExpression {
    return funcExpr.async
      ? this.createChain({
          ...super.visitFunctionExpression(funcExpr),
          async: false,
          generator: true,
        })
      : (this.visitFunctionExpression(funcExpr) as any); // SWC's types are broken, we can return any Expression here
  }

  public visitArrowFunctionExpression(
    funcExpr: ArrowFunctionExpression
  ): Expression {
    return funcExpr.async
      ? this.createChain(funcExpr)
      : super.visitArrowFunctionExpression(funcExpr);
  }

  /**
   * Hoist async {@link FunctionDeclaration} as {@link VariableDeclaration} {@link chain}s.
   */
  public visitBlockStatement(block: BlockStatement): BlockStatement {
    const functionStmts = block.stmts.filter(isAsyncFunctionDecl);

    return {
      ...block,
      stmts: [
        // hoist function decls and turn them into chains
        ...functionStmts.map((stmt) => this.createFunctionDeclChain(stmt)),
        ...block.stmts
          .filter((stmt) => !isAsyncFunctionDecl(stmt))
          .map((stmt) => this.visitStatement(stmt)),
      ],
    };
  }

  /**
   * Turn a {@link FunctionDeclaration} into a {@link VariableDeclaration} wrapped in {@link chain}.
   */
  private createFunctionDeclChain(
    funcDecl: FunctionDeclaration & { async: true }
  ): VariableDeclaration {
    return {
      type: "VariableDeclaration",
      span: funcDecl.span,
      kind: "const",
      declarations: [
        {
          type: "VariableDeclarator",
          span: funcDecl.span,
          definite: false,
          id: funcDecl.identifier,
          init: this.createChain(funcDecl),
        },
      ],
      declare: false,
    };
  }

  private createChain(
    funcExpr: FunctionExpression | ArrowFunctionExpression | FunctionDeclaration
  ): CallExpression {
    const call: CallExpression = {
      type: "CallExpression",
      span: funcExpr.span,
      callee: {
        type: "Identifier",
        value: "$eventual",
        optional: false,
        span: funcExpr.span,
      },
      arguments: [
        {
          expression: {
            type: "FunctionExpression",
            span: funcExpr.span,
            identifier:
              funcExpr.type === "FunctionExpression"
                ? funcExpr.identifier
                : undefined,
            async: false,
            generator: true,
            body:
              funcExpr.body?.type === "BlockStatement"
                ? this.visitBlockStatement(funcExpr.body)
                : funcExpr.body
                ? {
                    type: "BlockStatement",
                    span: getSpan(funcExpr.body),
                    stmts: [
                      {
                        type: "ReturnStatement",
                        span: getSpan(funcExpr.body),
                        argument: this.visitExpression(funcExpr.body),
                      },
                    ],
                  }
                : undefined,
            params: funcExpr.params.map((param) =>
              param.type === "Parameter"
                ? this.visitParameter(param)
                : <Param>{
                    type: "Parameter",
                    pat: this.visitPattern(param),
                    span: (<any>param).span ?? funcExpr.span,
                  }
            ),
          },
        },
      ],
    };
    return call;
  }
}

function hasSpan(expr: Node): expr is Node & HasSpan {
  return "span" in expr;
}

function getSpan(expr: Node): Span {
  if (hasSpan(expr)) {
    return expr.span;
  } else {
    // this is only true for JSXExpressions which we should not encounter
    throw new Error(`cannot get span of ${expr.type}`);
  }
}

/**
 * A heuristic for identifying a {@link CallExpression} that is a call
 * to the eventual.workflow utility:
 *
 * 1. must be a function call with exactly 2 arguments
 * 2. first argument is a string literal
 * 3. second argument is a FunctionExpression or ArrowFunctionExpression
 * 4. callee is an identifier `"workflow"` or `<identifier>.workflow`
 */
function isWorkflowCall(call: CallExpression): call is CallExpression & {
  arguments: [
    Argument & { expression: StringLiteral },
    Argument & { expression: FunctionExpression | ArrowFunctionExpression }
  ];
} {
  return (
    isWorkflowCallee(call.callee) &&
    call.arguments[0]?.expression.type === "StringLiteral" &&
    ((call.arguments.length === 2 &&
      isNonGeneratorFunction(call.arguments[1]?.expression)) ||
      (call.arguments.length === 3 &&
        isNonGeneratorFunction(call.arguments[2]?.expression)))
  );
}

function isNonGeneratorFunction(
  expr?: Expression
): expr is ArrowFunctionExpression | FunctionExpression {
  return (
    (expr?.type === "ArrowFunctionExpression" ||
      expr?.type === "FunctionExpression") &&
    !expr.generator
  );
}

function isWorkflowCallee(callee: CallExpression["callee"]) {
  return (
    (callee.type === "Identifier" && callee.value === "workflow") ||
    (callee.type === "MemberExpression" &&
      callee.property.type === "Identifier" &&
      callee.property.value === "workflow")
  );
}

function isAsyncFunctionDecl(
  stmt: Statement
): stmt is FunctionDeclaration & { async: true } {
  return stmt.type === "FunctionDeclaration" && stmt.async;
}
