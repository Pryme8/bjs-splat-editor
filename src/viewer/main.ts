/**
 * Standalone SQPZ Viewer Entry Point
 * Minimal app for viewing SQPZ files without editor functionality
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ViewerApp from './ViewerApp.vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import '../assets/styles/main.scss'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'dark',
    themes: {
      dark: {
        colors: {
          primary: '#6B8AFF',
          secondary: '#8B5CF6',
          accent: '#EC4899',
          error: '#EF4444',
          warning: '#F59E0B',
          info: '#3B82F6',
          success: '#10B981',
          background: '#0D0D12',
          surface: '#1A1A24',
        }
      }
    }
  }
})

const app = createApp(ViewerApp)
app.use(createPinia())
app.use(vuetify)
app.mount('#viewer-app')
