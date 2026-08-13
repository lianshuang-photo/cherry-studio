import type { Context } from '@deepseek-ai/cordis'
import {
  type CredentialInfo,
  CredentialProvider,
  type CredentialRef,
  credentialRef,
  type ResolvedCredential
} from '@deepseek-ai/dsh-credentials'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import * as PiAiAdapterPlugin from '@deepseek-ai/dsh-llm-pi-ai'

import type { DshProviderInjection } from './modelInjection'

class CherryDshCredentialProvider extends CredentialProvider {
  constructor(
    ctx: Context,
    private readonly ref: CredentialRef,
    private readonly apiKey: string
  ) {
    super(ctx)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(ref === this.ref ? { value: this.apiKey, source: 'cherry' } : undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      configured: ref === this.ref,
      ...(ref === this.ref ? { source: 'cherry' } : {}),
      writable: false
    })
  }

  override set(): Promise<void> {
    return Promise.reject(new Error('Cherry manages DSH credentials'))
  }

  override unset(): Promise<void> {
    return Promise.reject(new Error('Cherry manages DSH credentials'))
  }
}

/**
 * Mount the official pi-ai adapter against one private Cherry-managed route.
 * The credential provider lives in this Cordis tree and is disposed with it.
 */
export async function installDshModelBridge(ctx: Context, injection: DshProviderInjection): Promise<void> {
  await ctx.plugin((credentialContext) => {
    new CherryDshCredentialProvider(credentialContext, credentialRef(injection.credentialRef), injection.apiKey)
  })

  const profile: PiAiProviderProfile = {
    displayName: injection.usageCapture.providerName ?? injection.providerRoute,
    apiKeyEnv: injection.credentialRef,
    api: injection.api,
    baseURL: injection.baseURL,
    models: [
      {
        id: injection.modelId,
        name: injection.usageCapture.frozenModels[0]?.modelName ?? injection.modelId,
        ...(injection.contextWindow ? { contextWindow: injection.contextWindow } : {}),
        ...(injection.maxTokens ? { maxTokens: injection.maxTokens } : {}),
        input: injection.input
      }
    ],
    ...(injection.headers ? { headers: injection.headers } : {})
  }
  await ctx.plugin(PiAiAdapterPlugin, { providers: { [injection.providerRoute]: profile } })
}
