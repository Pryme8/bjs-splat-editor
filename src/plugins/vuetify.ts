import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'

const QuantumTheme = {
  dark: true,
  colors: {
    background: '#0D0D12',
    surface: '#1A1A24',
    'surface-bright': '#252532',
    'surface-variant': '#252532',
    primary: '#6B8AFF',
    secondary: '#9D7AFF',
    accent: '#4ECDC4',
    error: '#FF6B6B',
    warning: '#FFB347',
    info: '#6B8AFF',
    success: '#4ECDC4',
    'on-background': '#E8E8F0',
    'on-surface': '#E8E8F0',
    'on-primary': '#0D0D12',
    'on-secondary': '#0D0D12',
    'on-accent': '#0D0D12',
    'on-error': '#0D0D12',
    'on-warning': '#0D0D12',
    'on-info': '#0D0D12',
    'on-success': '#0D0D12',
  },
  variables: {
    'border-color': '#3A3A4A',
    'border-opacity': 0.12,
    'high-emphasis-opacity': 0.95,
    'medium-emphasis-opacity': 0.7,
    'disabled-opacity': 0.38,
    'hover-opacity': 0.08,
    'focus-opacity': 0.12,
    'pressed-opacity': 0.16,
  }
}

export default createVuetify({
  theme: {
    defaultTheme: 'QuantumTheme',
    themes: {
      QuantumTheme
    }
  },
  defaults: {
    VBtn: {
      variant: 'text',
      rounded: 'lg',
    },
    VCard: {
      rounded: 'lg',
      elevation: 0,
    },
    VTextField: {
      variant: 'outlined',
      density: 'compact',
    },
    VSelect: {
      variant: 'outlined',
      density: 'compact',
    },
    VSlider: {
      color: 'primary',
      trackColor: 'surface-variant',
    },
  }
})
