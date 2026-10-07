import { render } from 'preact'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'
import { seedDemoDataIfEmpty } from './seed'

seedDemoDataIfEmpty()
  .catch((e) => console.error('Demo seed failed:', e))
  .finally(() => render(<App />, document.getElementById('app')!))
