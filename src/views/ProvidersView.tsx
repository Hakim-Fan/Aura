import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
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

  // Define a reusable minimal input class for UnoCSS
  const premiumInputClass = "w-full px-3.5 py-2.5 rounded-xl border border-black/8 bg-white focus:border-black/20 outline-none transition-all duration-200 font-500"
  const labelClass = "text-11px font-700 text-[var(--text-secondary)] opacity-50 uppercase tracking-0.05em text-right"

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
        <section className="providers-list-card custom-scrollbar">
          <header className="providers-list-header">
            <div className="providers-list-title">
              <div className="section-title">提供商实例</div>
              <p className="muted">管理 API 实例配置</p>
            </div>
            <button className="create-provider-btn" onClick={onCreateProfile} title="新增提供商">
              <Plus size={16} />
            </button>
          </header>

          <div className="provider-cards-stack">
            {profiles.map(profile => {
              const isActive = profile.id === activeProfileId
              const profileEnabledModels = profile.models.filter(model => model.enabled).length
              const baseUrl = profile.baseUrl || baseUrlPlaceholder(profile.provider)

              return (
                <button
                  key={profile.id}
                  className={`modern-provider-card ${isActive ? 'active' : ''} ${profile.enabled ? '' : 'disabled'}`}
                  onClick={() => onSelectProfile(profile.id)}
                >
                  <div className="card-top">
                    <span className="profile-name">{profile.name}</span>
                    <span className="provider-type-tag">{providerOptions.find(item => item.id === profile.provider)?.label || profile.provider}</span>
                  </div>

                  <div className="card-url" title={baseUrl}>{baseUrl}</div>

                  <div className="card-footer">
                    <div className="status-indicator">
                      <span className={`status-dot ${profile.enabled ? 'online' : 'offline'}`} />
                      <span>{profile.enabled ? '启用中' : '已停用'}</span>
                    </div>
                    <span className="models-count">
                      {profileEnabledModels > 0 ? `${profileEnabledModels} Models` : '未选模型'}
                    </span>
                  </div>

                  {isActive && <div className="active-glow" />}
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
              <button
                className="w-10 h-10 flex items-center justify-center rounded-xl bg-black/4 hover:bg-black/8 hover:text-red-500 transition-all"
                onClick={() => onDeleteProfile(activeProfile.id)}
                title="删除提供商"
              >
                <Trash2 size={16} />
              </button>

              <button
                className={`flex items-center gap-3 px-3 py-1.5 rounded-xl border transition-all ${activeProfile.enabled ? 'bg-green-50/50 border-green-200/50 text-green-700' : 'bg-black/4 border-transparent text-[var(--text-secondary)]'
                  }`}
                onClick={() => onProfileChange(activeProfile.id, 'enabled', !activeProfile.enabled)}
              >
                <div className={`w-8 h-4.5 rounded-full p-0.5 transition-colors duration-200 ${activeProfile.enabled ? 'bg-green-600' : 'bg-black/20'}`}>
                  <div className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${activeProfile.enabled ? 'translate-x-3.5' : 'translate-x-0'}`} />
                </div>
                <span className="text-12px font-600">{activeProfile.enabled ? '已启用' : '已停用'}</span>
              </button>
            </div>
          </div>

          <div className="form-container">
            <div className="form-row">
              <label className={labelClass}>显示名称</label>
              <input
                className={premiumInputClass}
                value={activeProfile.name}
                onChange={event => onProfileChange(activeProfile.id, 'name', event.target.value)}
                placeholder="例如 OpenRouter / Nvidia / Moonshot"
              />
            </div>

            <div className="form-row">
              <label className={labelClass}>Provider 类型</label>
              <div className="settings-tabs !mb-0">
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
            </div>

            <div className="form-row">
              <label className={labelClass}>API Key</label>
              <input
                className={`${premiumInputClass} font-mono !text-12px`}
                value={activeProfile.apiKey}
                onChange={event => onProfileChange(activeProfile.id, 'apiKey', event.target.value)}
                placeholder="输入真实 API Key"
                type="password"
              />
            </div>

            <div className="form-row">
              <label className={labelClass}>Base URL</label>
              <input
                className={`${premiumInputClass} font-mono !text-12px`}
                value={activeProfile.baseUrl}
                onChange={event => onProfileChange(activeProfile.id, 'baseUrl', event.target.value)}
                placeholder={baseUrlPlaceholder(activeProfile.provider)}
              />
            </div>

            <div className="form-row">
              <label className={labelClass}></label>
              <div className="flex gap-3">
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black/4 hover:bg-black/8 disabled:opacity-40 transition-all font-600 text-13px"
                  disabled={isTesting}
                  onClick={onTestConnection}
                >
                  <RefreshCw className={isTesting ? 'animate-spin' : ''} size={14} />
                  <span>{isTesting ? '正在测试...' : '测试连通性'}</span>
                </button>
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black/4 hover:bg-black/8 disabled:opacity-40 transition-all font-600 text-13px"
                  disabled={isFetchingModels}
                  onClick={onFetchModels}
                >
                  <RefreshCw className={isFetchingModels ? 'animate-spin' : ''} size={14} />
                  <span>{isFetchingModels ? '正在获取...' : '获取模型列表'}</span>
                </button>
              </div>
            </div>

            {providerStatus ? (
              <div className="form-row">
                <label className={labelClass}></label>
                <div className={`px-4 py-3 rounded-xl border flex items-start gap-3 transition-all ${providerStatus.tone === 'success'
                  ? 'bg-green-50/50 border-green-200/50 text-green-700'
                  : 'bg-red-50/50 border-red-200/50 text-red-700'
                  }`}>
                  <div>
                    {providerStatus.tone === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  </div>
                  <div className="flex-1 text-13px font-500">
                    {providerStatus.message}
                  </div>
                </div>
              </div>
            ) : null}

            <section className="provider-note provider-models-panel mt-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="section-title mb-1">模型管理</div>
                  <p className="muted">启用后的模型将出现在聊天页的快速切换列表中。</p>
                </div>
                <span className="micro-pill">{enabledModelCount} / {activeProfile.models.length} 已启用</span>
              </div>

              {activeProfile.models.length > 0 ? (
                <div className="provider-models-body">
                  <div className="provider-model-search">
                    <Search size={14} />
                    <input
                      className="border-none bg-transparent flex-1 p-0 focus:outline-none focus:ring-0 text-13px"
                      value={modelQuery}
                      onChange={event => setModelQuery(event.target.value)}
                      placeholder="搜索模型名称..."
                      type="text"
                    />
                  </div>

                  <div className="provider-models-scroll custom-scrollbar">
                    {filteredModels.length > 0 ? (
                      <div className="flex flex-col">
                        {filteredModels.map(model => (
                          <div key={model.id} className="dashboard-row modern !items-center">
                            <div className="flex-1 min-w-0 pr-4">
                              <strong className="truncate">{model.id.split('/').filter(Boolean).at(-1) || model.id}</strong>
                              <span className="truncate block opacity-60 text-[11px]">{model.id}</span>
                            </div>
                            <div className="flex items-center">
                              <button
                                className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none ${model.enabled ? 'bg-[var(--bg-user-bubble)]' : 'bg-black/10'}`}
                                onClick={() => onToggleModel(activeProfile.id, model.id)}
                              >
                                <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 transform ${model.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <article className="asset-card empty">
                        <strong>没有匹配的模型</strong>
                        <p>请尝试其他关键词。</p>
                      </article>
                    )}
                  </div>
                </div>
              ) : (
                <article className="asset-card empty">
                  <strong>暂无模型数据</strong>
                  <p>请先测试连通性并点击“获取模型列表”。</p>
                </article>
              )}
            </section>
          </div>
        </section>
      </div>
    </section>
  )
}
