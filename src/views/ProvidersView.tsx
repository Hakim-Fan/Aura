import type { AgentSettings, ProviderPreset } from '../types'

function ProviderStatus({ dot }: { dot: ProviderPreset['dot'] }) {
  return <span className={`provider-dot ${dot}`} />
}

type Props = {
  providerSearch: string
  visibleProviders: ProviderPreset[]
  selectedProviderId: string
  selectedProvider: ProviderPreset
  customProviderPreset: ProviderPreset
  settings: AgentSettings
  onProviderSearchChange: (value: string) => void
  onApplyPreset: (preset: ProviderPreset) => void
  onSettingsChange: <K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) => void
  onCopyApiKey: () => void
  onClose: () => void
  onStartChat: () => void
}

export function ProvidersView({
  providerSearch,
  visibleProviders,
  selectedProviderId,
  selectedProvider,
  customProviderPreset,
  settings,
  onProviderSearchChange,
  onApplyPreset,
  onSettingsChange,
  onCopyApiKey,
  onClose,
  onStartChat,
}: Props) {
  return (
    <section className="section-shell">
      <header className="section-header">
        <div>
          <div className="eyebrow">Providers</div>
          <h2>提供商</h2>
        </div>
        <div className="header-actions">
          <button
            className="secondary-button"
            onClick={() => onApplyPreset(customProviderPreset)}
          >
            Add Custom Provider
          </button>
          <button className="primary-button">Add Custom ACP Provider</button>
        </div>
      </header>

      <div className="providers-layout">
        <section className="providers-list-card">
          <div className="search-field">
            <span className="search-glyph">/</span>
            <input
              value={providerSearch}
              onChange={event => onProviderSearchChange(event.target.value)}
              placeholder="搜索提供商..."
            />
          </div>
          <div className="providers-list">
            {visibleProviders.map(provider => (
              <button
                key={provider.id}
                className={
                  provider.id === selectedProviderId ? 'provider-card active' : 'provider-card'
                }
                onClick={() => onApplyPreset(provider)}
              >
                <div className="provider-card-head">
                  <div className="provider-ident">
                    <span className="provider-glyph">{provider.name.slice(0, 1)}</span>
                    <div>
                      <strong>{provider.name}</strong>
                      <p>{provider.subtitle}</p>
                    </div>
                  </div>
                  <div className="provider-meta">
                    {provider.badge ? <span className="badge-chip">{provider.badge}</span> : null}
                    <ProviderStatus dot={provider.dot} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="provider-detail-card">
          <div className="provider-detail-head">
            <div>
              <div className="inline-row">
                <h3>{selectedProvider.name}</h3>
                <span className="status-pill">{settings.apiKey ? 'Active' : 'Inactive'}</span>
              </div>
              <p>{selectedProvider.subtitle}</p>
            </div>
            <button className="toggle-shell" type="button">
              <span className={settings.apiKey ? 'toggle-knob on' : 'toggle-knob'} />
            </button>
          </div>

          <div className="provider-detail-grid">
            <div className="provider-banner">
              <div className="inline-between">
                <strong>API 代理端点</strong>
                <span className="micro-pill">高级</span>
              </div>
              <p>可留空走默认端点，也可以替换成自己的网关、代理或兼容服务。</p>
            </div>

            <label>
              API Key
              <div className="inline-field">
                <input
                  value={settings.apiKey}
                  onChange={event => onSettingsChange('apiKey', event.target.value)}
                  placeholder="Enter your API key"
                  type="password"
                />
                <button className="mini-button" onClick={onCopyApiKey}>
                  复制
                </button>
              </div>
            </label>

            <label>
              Base URL
              <input
                value={settings.baseUrl}
                onChange={event => onSettingsChange('baseUrl', event.target.value)}
                placeholder={selectedProvider.baseUrl || 'https://api.example.com/v1'}
              />
            </label>

            <label>
              Model
              <input
                value={settings.model}
                onChange={event => onSettingsChange('model', event.target.value)}
                placeholder={selectedProvider.modelHint}
              />
            </label>

            <div className="provider-footnote">
              <span>所有更改已自动保存。</span>
              <div className="header-actions">
                <button className="secondary-button" onClick={onClose}>
                  关闭
                </button>
                <button className="primary-button" onClick={onStartChat}>
                  保存并开始聊天
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}
