import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-plugin-workbench', ['src/index.ts'], {
  portableCssModuleIds: true,
})
