import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, Power, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { ProviderMode, ProviderProfile } from '../types'

const providerOptions: Array<{
  id: ProviderMode
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
  profiles: ProviderProfile[]
  activeProfileId: string
  providerStatus: {
    tone: 'success' | 'error'
    message: string
  } | null
  isTesting: boolean
  isFetchingModels: boolean
  onSelectProfile: (profileId: string) => void
  onCreateProfile: () => void
  onDeleteProfile: (profileId: string) => void
  onProfileChange: <K extends keyof ProviderProfile>(
    profileId: string,
    key: K,
    value: ProviderProfile[K],
  ) => void
  onToggleModel: (profileId: string, modelId: string) => void
  onTestConnection: () => void
  onFetchModels: () => void
}

function baseUrlPlaceholder(provider: ProviderMode) {
  return provider === 'google'
    ? 'https://generativelanguage.googleapis.com/v1beta'
    : 'https://api.openai.com/v1'
}

export function ProvidersView({
  profiles,
  activeProfileId,
  providerStatus,
  isTesting,
  isFetchingModels,
  onSelectProfile,
  onCreateProfile,
  onDeleteProfile,
  onProfileChange,
  onToggleModel,
  onTestConnection,
  onFetchModels,
}: Props) {
  const activeProfile = profiles.find(profile => profile.id === activeProfileId) || profiles[0]
  const [modelQuery, setModelQuery] = useState('')

  useEffect(() => {
    setModelQuery('')
  }, [activeProfile?.id])

  const enabledModelCount = activeProfile?.models.filter(model => model.enabled).length || 0
  const filteredModels = useMemo(() => {
    if (!activeProfile) {
      return []
    }
    const keyword = modelQuery.trim().toLowerCase()
    if (!keyword) {
      return activeProfile.models
    }
    return activeProfile.models.filter(model => model.id.toLowerCase().includes(keyword))
  }, [activeProfile?.models, modelQuery])

  if (!activeProfile) {
    return null
  }

  return (
    <section className="section-shell settings-panel providers-panel">
      <div className="providers-layout">
        <section className="providers-list-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="section-title">提供商实例</div>
              <p className="muted">把不同 API 服务保存成独立 profile，聊天页就能直接切换模型。</p>
            </div>
            <button className="secondary-button" onClick={onCreateProfile}>
              <Plus size={14} />
              新增
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {profiles.map(profile => {
              const isActive = profile.id === activeProfileId
              const profileEnabledModels = profile.models.filter(model => model.enabled).length
              return (
                <button
                  key={profile.id}
                  className={isActive ? 'provider-card active' : 'provider-card'}
                  onClick={() => onSelectProfile(profile.id)}
                >
                  <div className="provider-card-head">
                    <strong>{profile.name}</strong>
                    <span className="micro-pill">{providerOptions.find(item => item.id === profile.provider)?.label || profile.provider}</span>
                  </div>
                  <p>{profile.baseUrl || baseUrlPlaceholder(profile.provider)}</p>
                  <div className="asset-card-meta mt-3">
                    <span className={`micro-pill ${profile.enabled ? '' : 'opacity-50'}`}>{profile.enabled ? '启用中' : '停用'}</span>
                    <span className={`micro-pill ${profileEnabledModels > 0 ? '' : 'opacity-50'}`}>
                      {profileEnabledModels > 0 ? `${profileEnabledModels} 个模型已启用` : '未启用模型'}
                    </span>
                    {profile.id === activeProfileId ? <span className="micro-pill">查看中</span> : null}
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="provider-detail-card">
          <div className="provider-detail-head">
            <div>
              <div className="eyebrow">Provider Profile</div>
              <h2>{activeProfile.name}</h2>
              <p className="muted mt-2">{providerOptions.find(item => item.id === activeProfile.provider)?.description}</p>
            </div>

            <div className="header-actions">
              <button className="secondary-button" onClick={() => onDeleteProfile(activeProfile.id)} title="删除提供商">
                <Trash2 size={14} />
              </button>
              <label className="toggle-inline">
                <input
                  checked={activeProfile.enabled}
                  onChange={event => onProfileChange(activeProfile.id, 'enabled', event.target.checked)}
                  type="checkbox"
                />
                {activeProfile.enabled ? '已启用' : '已停用'}
              </label>
            </div>
          </div>

          <div className="provider-detail-grid">
            <div className="grid grid-cols-2 gap-4">
              <label>
                显示名称
                <input
                  value={activeProfile.name}
                  onChange={event => onProfileChange(activeProfile.id, 'name', event.target.value)}
                  placeholder="例如 OpenRouter / Nvidia / Moonshot"
                />
              </label>

              <label>
                Provider 类型
                <div className="asset-card-meta">
                  {providerOptions.map(option => (
                    <button
                      key={option.id}
                      className={option.id === activeProfile.provider ? 'settings-tab active' : 'settings-tab'}
                      onClick={() => onProfileChange(activeProfile.id, 'provider', option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </label>
            </div>

            <div className="header-actions">
              <button className="secondary-button" disabled={isTesting} onClick={onTestConnection}>
                <RefreshCw className={isTesting ? 'spin-icon' : ''} size={14} />
                {isTesting ? '测试中...' : '测试连通性'}
              </button>
              <button className="secondary-button" disabled={isFetchingModels} onClick={onFetchModels}>
                <RefreshCw className={isFetchingModels ? 'spin-icon' : ''} size={14} />
                {isFetchingModels ? '拉取中...' : '获取模型'}
              </button>
            </div>

            <label>
              API Key
              <input
                value={activeProfile.apiKey}
                onChange={event => onProfileChange(activeProfile.id, 'apiKey', event.target.value)}
                placeholder="输入真实 API Key"
                type="password"
              />
            </label>

            <label>
              Base URL
              <input
                value={activeProfile.baseUrl}
                onChange={event => onProfileChange(activeProfile.id, 'baseUrl', event.target.value)}
                placeholder={baseUrlPlaceholder(activeProfile.provider)}
              />
            </label>

            {providerStatus ? (
              <div className={`provider-note provider-feedback ${providerStatus.tone}`}>
                <p className="muted">{providerStatus.message}</p>
              </div>
            ) : null}

            <section className="provider-note provider-models-panel">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="section-title mb-1">模型列表</div>
                  <p className="muted">只展示已经拉取到的模型。启用后，聊天页输入框下方才能直接切换。</p>
                </div>
                <span className="micro-pill">{enabledModelCount} / {activeProfile.models.length} 个已启用</span>
              </div>

              {activeProfile.models.length > 0 ? (
                <div className="provider-models-body">
                  <label className="provider-model-search">
                    <Search size={14} />
                    <input
                      value={modelQuery}
                      onChange={event => setModelQuery(event.target.value)}
                      placeholder="搜索当前 provider 的模型"
                      type="text"
                    />
                  </label>

                  <div className="provider-models-scroll custom-scrollbar">
                    {filteredModels.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {filteredModels.map(model => (
                          <div key={model.id} className="dashboard-row modern !items-center">
                            <div>
                              <strong>{model.id.split('/').filter(Boolean).at(-1) || model.id}</strong>
                              <span>{model.id}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={model.enabled ? 'model-state-pill enabled' : 'model-state-pill'}>
                                {model.enabled ? '已启用' : '已关闭'}
                              </span>
                              <button
                                className={model.enabled ? 'secondary-button' : 'primary-button'}
                                onClick={() => onToggleModel(activeProfile.id, model.id)}
                              >
                                {model.enabled ? <Power size={12} /> : <Check size={12} />}
                                {model.enabled ? '关闭' : '启用'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <article className="asset-card empty">
                        <strong>没有匹配的模型</strong>
                        <p>换个关键词试试，或者清空搜索后再继续启用模型。</p>
                      </article>
                    )}
                  </div>
                </div>
              ) : (
                <article className="asset-card empty">
                  <strong>还没有模型列表</strong>
                  <p>先测试连通性并获取模型，再手动启用需要出现在聊天页的模型。</p>
                </article>
              )}
            </section>
          </div>
        </section>
      </div>
    </section>
  )
}
