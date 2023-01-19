import { Multicall } from '../SearcherArbitrage.ts'
import { ethers } from '../deps.ts'

const expectedSignature = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
const expectedCommand = 'v3SwapExactInput(address,uint256,uint256,bytes,bool)'

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

// function decodePath(path: string) {
//   return ethers.utils.defaultAbiCoder.decode(['address', 'uint24', 'address'], input)
//   0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6000bb830efddec56be2987bf5902ce791425465266e839
// }

export function getUniswapUniversalTradeParams(multicall: Multicall, msgSender?: string) {
  const calls = multicall.calls
  let exactInputSingle

  if (!calls) {
    console.error('no calls')
    return
  }

  for (const candidates of calls) {
    if (candidates) {
      for (const call of candidates) {
        if (call.signature === expectedCommand) {
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

  const [recipient, amountIn, amountOutMin, path, _payerIsUser] = exactInputSingle.parameters
  console.log(path.value)
  const tokenIn = ethers.utils.hexDataSlice(path.value, 0, 20)
  const fee = ethers.utils.hexDataSlice(path.value, 20, 23)
  const tokenOut = ethers.utils.hexDataSlice(path.value, 23)

  // const [tokenIn, fee, tokenOut] = ethers.utils.defaultAbiCoder.decode(['address', 'address'], path.value)

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
    amountOutMin,
    sqrtPriceLimitX96: 0,
  }
}
