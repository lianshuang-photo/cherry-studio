export type DshBuiltinToolCategory = 'file' | 'shell' | 'search' | 'plan' | 'delegate' | 'skill'

export type DshBuiltinToolDescriptor = {
  /** dsh runtime-native tool name == disabledTools write-back id. Never rename. */
  name: string
  category: DshBuiltinToolCategory
  approval: 'auto' | 'prompt'
}

export const DSH_BUILTIN_TOOLS = [
  { name: 'bash', category: 'shell', approval: 'prompt' },
  { name: 'str_replace_editor', category: 'file', approval: 'prompt' },
  { name: 'read', category: 'file', approval: 'auto' },
  { name: 'write', category: 'file', approval: 'prompt' },
  { name: 'edit', category: 'file', approval: 'prompt' },
  { name: 'todo_write', category: 'plan', approval: 'auto' },
  { name: 'subagent', category: 'delegate', approval: 'prompt' },
  { name: 'skill', category: 'skill', approval: 'auto' }
] as const satisfies readonly DshBuiltinToolDescriptor[]
