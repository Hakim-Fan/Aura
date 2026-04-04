import { defineConfig, presetUno, presetAttributify, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons()
  ],
  shortcuts: {
    'flex-center': 'flex justify-center items-center',
    'flex-between': 'flex justify-between items-center',
  },
  theme: {
    colors: {
      primary: '#4f7cff',
      panel: 'var(--bg-panel)',
      sidebar: 'var(--bg-sidebar)',
      textPrimary: 'var(--text-1)',
      textSecondary: 'var(--text-2)',
      textMuted: 'var(--text-3)',
      borderSubtle: 'var(--border-subtle)',
    }
  }
})
