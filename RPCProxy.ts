import { ethers } from './deps.ts'
import { config } from './deps.ts'

const env = config()

const rpcUrl = `wss://${env['CHAIN_NAME']}.infura.io/ws/v3/${env['INFURA_KEY']}`
const ws = new WebSocket(rpcUrl)

const rpc = new ethers.providers.WebSocketProvider(ws, {
  name: env['CHAIN_NAME'],
  chainId: parseInt(env['CHAIN_ID']),
})

export default rpc
