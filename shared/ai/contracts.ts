import { z } from 'zod'

const nonEmptyString = z.string().refine((value) => value.trim().length > 0)

const conversationMessageSchema = z
  .object({
    id: nonEmptyString,
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    createdAt: z.number().optional()
  })
  .strict()

const documentSnapshotSchema = z
  .object({
    id: nonEmptyString,
    title: z.string(),
    path: z.string().nullable(),
    format: z.enum(['markdown', 'mdx', 'mindmap', 'diagram', 'image', 'pdf']),
    content: z.string(),
    revision: z.number().int().nonnegative(),
    contentHash: z.string(),
    modified: z.boolean()
  })
  .strict()

const selectionSnapshotSchema = z
  .object({
    text: z.string(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative()
  })
  .strict()

export const aiRunInputSchema = z
  .object({
    conversationId: nonEmptyString,
    message: nonEmptyString,
    history: z.array(conversationMessageSchema),
    snapshot: z
      .object({
        runId: nonEmptyString.optional(),
        conversationId: nonEmptyString,
        activeDocument: documentSnapshotSchema.nullable(),
        selection: selectionSnapshotSchema.nullable(),
        cursor: z.number().int().nonnegative().nullable(),
        workspaceRoot: z.string().nullable()
      })
      .strict()
  })
  .strict()

export const runIdSchema = nonEmptyString

export const approvalDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), scope: z.literal('once') }).strict(),
  z.object({ status: z.literal('rejected'), reason: z.string().optional() }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('expired') }).strict()
])

export const toolExecutionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['completed', 'applied']), data: z.unknown().optional() }),
  z.object({
    status: z.enum(['rejected', 'conflict', 'failed', 'cancelled']),
    message: z.string()
  })
])

export const approvalResolutionSchema = z
  .object({
    id: nonEmptyString,
    decision: approvalDecisionSchema,
    result: toolExecutionResultSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision.status !== 'approved' && value.result !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: '仅已批准的审批可包含执行结果'
      })
    }
  })
