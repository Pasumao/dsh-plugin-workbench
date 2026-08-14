import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@dsh-external/dsh-plugin-workbench', ['src/index.ts'], {
  portableCssModuleIds: true,
})
