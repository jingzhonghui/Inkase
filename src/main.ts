import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAppearanceStore } from './stores/appearance'
import './styles/index.css'

const app = createApp(App)

app.use(createPinia())
useAppearanceStore().initAppearance()
app.mount('#app')
