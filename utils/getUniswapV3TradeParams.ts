import { Multicall } from '../SearcherArbitrage.ts'

const expectedSignature = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'

export function getUniswapV3TradeParams(multicall: Multicall, msgSender?: string) {
  const calls = multicall.calls
  let exactInputSingle

  if (!calls) {
    console.error('no calls')
    return
  }

  for (const candidates of calls) {
    if (candidates) {
      for (const call of candidates) {
        if (call.signature === expectedSignature) {
          exactInputSingle = call
          break
        }
      }
    }
    if (exactInputSingle) {
      break
    }
  }

  if (!exactInputSingle) {
    console.error('no exactInputSingle')
    return
  }

  const parameters = exactInputSingle.parameters[0].value
  const [tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96] = parameters

  return {
    tokenIn,
    tokenOut,
    fee,
    // if recipient not set, use msg.sender since router defaults to that
    recipient:
      recipient === '0x0000000000000000000000000000000000000002'
        ? msgSender || '0x0000000000000000000000000000000000000002'
        : recipient,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96,
  }
}
