import type { AgentSettings } from '../types'

const providerOptions: Array<{
  id: AgentSettings['provider']
  label: string
  description: string
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: '适合 GPT 系列模型和 OpenAI 原生 API。',
  },
  {
    id: 'google',
    label: 'Google',
    description: '适合 Gemini 原生 API。',
  },
  {
    id: 'custom',
    label: 'Custom',
    description: '适合兼容 OpenAI API 的自定义服务。',
  },
]

type Props = {
  settings: AgentSettings
  availableModels: string[]
  providerStatus: string
  isTesting: boolean
  isFetchingModels: boolean
  onProviderChange: (provider: AgentSettings['provider']) => void
  onSettingsChange: <K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) => void
  onTestConnection: () => void
  onFetchModels: () => void
}

export function ProvidersView({
  settings,
  availableModels,
  providerStatus,
  isTesting,
  isFetchingModels,
  onProviderChange,
  onSettingsChange,
  onTestConnection,
  onFetchModels,
}: Props) {
  const baseUrlPlaceholder =
    settings.provider === 'google'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : 'https://api.openai.com/v1'

  const modelPlaceholder =
    settings.provider === 'google' ? 'gemini-2.5-pro-exp-03-25' : 'gpt-5.1'

  return (
    <section className="section-shell settings-panel">
      <div className="providers-layout simple">
        <section className="providers-list-card">
          <div className="section-title">预设提供商</div>
          <div className="providers-list">
            {providerOptions.map(provider => (
              <button
                key={provider.id}
                className={
                  provider.id === settings.provider ? 'provider-card active' : 'provider-card'
                }
                onClick={() => onProviderChange(provider.id)}
              >
                <div className="provider-card-head">
                  <strong>{provider.label}</strong>
                  <span className="micro-pill">
                    {provider.id === settings.provider ? '当前使用' : '可选'}
                  </span>
                </div>
                <p>{provider.description}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="provider-detail-card">
          <div className="provider-detail-head">
            <div>
              <div className="eyebrow">Provider</div>
              <h2>{providerOptions.find(item => item.id === settings.provider)?.label}</h2>
            </div>
          </div>

          <div className="provider-detail-grid">
            <div className="header-actions">
              <button
                className="secondary-button"
                disabled={isTesting}
                onClick={onTestConnection}
              >
                {isTesting ? '测试中...' : '测试连通性'}
              </button>
              <button
                className="secondary-button"
                disabled={isFetchingModels}
                onClick={onFetchModels}
              >
                {isFetchingModels ? '拉取中...' : 'Fetch Models'}
              </button>
            </div>

            <label>
              API Key
              <input
                value={settings.apiKey}
                onChange={event => onSettingsChange('apiKey', event.target.value)}
                placeholder="输入真实 API Key"
                type="password"
              />
            </label>

            <label>
              Base URL
              <input
                value={settings.baseUrl}
                onChange={event => onSettingsChange('baseUrl', event.target.value)}
                placeholder={baseUrlPlaceholder}
              />
            </label>

            <label>
              默认模型
              <input
                value={settings.model}
                onChange={event => onSettingsChange('model', event.target.value)}
                placeholder={modelPlaceholder}
              />
            </label>

            {providerStatus ? <div className="provider-note"><p className="muted">{providerStatus}</p></div> : null}

            {availableModels.length > 0 ? (
              <section className="provider-note">
                <div className="section-title">已获取模型</div>
                <div className="asset-card-meta">
                  {availableModels.map(model => (
                    <button
                      key={model}
                      className={
                        model === settings.model ? 'settings-tab active' : 'settings-tab'
                      }
                      onClick={() => onSettingsChange('model', model)}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  )
}
