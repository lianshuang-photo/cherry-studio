export type DshBuiltinToolCategory = 'file' | 'shell' | 'context' | 'media' | 'orchestration'

export type DshBuiltinToolDescriptor = {
  /** dsh runtime-native tool name == disabledTools write-back id. Never rename. */
  name: string
  category: DshBuiltinToolCategory
  approval: 'auto' | 'prompt'
}

export const DSH_BUILTIN_TOOLS = [
  { name: 'bash', category: 'shell', approval: 'prompt' },
  { name: 'read', category: 'file', approval: 'auto' },
  { name: 'read_image', category: 'media', approval: 'auto' },
  { name: 'write', category: 'file', approval: 'prompt' },
  { name: 'edit', category: 'file', approval: 'prompt' },
  { name: 'todo_write', category: 'orchestration', approval: 'auto' },
  { name: 'subagent', category: 'orchestration', approval: 'prompt' },
  { name: 'ask_user_question', category: 'orchestration', approval: 'auto' },
  { name: 'exit_plan_mode', category: 'orchestration', approval: 'auto' },
  { name: 'skill', category: 'context', approval: 'auto' }
] as const satisfies readonly DshBuiltinToolDescriptor[]
