import { ethers } from './deps.ts'
import { config } from './deps.ts'

const env = config()
const rpcUrl = `https://${env['CHAIN_NAME']}.infura.io/v3/${env['INFURA_KEY']}`
const rpc = new ethers.providers.JsonRpcProvider(rpcUrl, {
  name: env['CHAIN_NAME'],
  chainId: parseInt(env['CHAIN_ID']),
})

export default rpc
