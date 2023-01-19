import { ethers } from '../deps.ts'

import { Multicall } from '../SearcherArbitrage.ts'
// Ref: https://ethereum.stackexchange.com/questions/125052/decode-multicall-bytes-into-readable-format

const FOURBYTES_ENDPOINT = 'https://www.4byte.directory/api/v1/signatures/?hex_signature='

const staticLookups: { [fourBytes: string]: string } = {
  '04e45aaf': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  b858183f: 'exactInput((bytes,address,uint256,uint256))',
  f3995c67: 'selfPermit(address,uint256,uint256,uint8,bytes32,bytes32)',
  '49404b7c': 'unwrapWETH9(uint256,address)',
  '5023b4df': 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  '12210e8a': 'refundETH()',
}

const commandLookup: { [fourBytes: string]: string } = {
  '00': 'v3SwapExactInput(address,uint256,uint256,bytes,bool)',
  // address recipient, uint256 amountIn, uint256 amountOutMin, bytes memory path, bool payerIsUser
}

/**
 * Takes a Solidity function signature (e.g. `add(uint256,uint256)`) and returns and array of parameter types (`['uint256', 'uint256']`)
 */
function extractParametersFromSignature(signature: string) {
  // console.log('signature: ', signature)
  const params = []
  const allParameters = /\b[^()]+\((.*)\)$/gm
  // extracts everything between parathesis: "method(result)"
  const splitParameters = /((\(.+?\))|([^,() ]+)){1}/gm
  // takes the first parameter, whatever it is, even if it's an (object)

  const _allParameters = allParameters.exec(signature)![1]
  let match

  // console.log('all params', _allParameters)
  while ((match = splitParameters.exec(_allParameters))) {
    // console.log('match', match)
    params.push(match[0])
  }

  // console.log('final params', params)
  return params
}

/**
 * Takes an array of hex bytes strings from a call or a multicall and attempts to decode it.
 * Looks up potential message signatures from a 4-bytes database, attempts to decode, and succeessful, records that as a decoding candidate.
 * Returns an array, with item for each call; item is an array of decoding candidates (usually one).
 */
async function decodeCalls(calls: string[]): Promise<Multicall['calls']> {
  const result: Multicall['calls'] = []

  for (const call of calls) {
    const strippedCall = call.replace('0x', '')
    const functionSelector = strippedCall.slice(0, 8)
    const data = strippedCall.slice(8)

    const lookupResults = []
    const candidates = []

    if (staticLookups[functionSelector]) {
      lookupResults.push(staticLookups[functionSelector])
    } else {
      const signatureResponse = await fetch(FOURBYTES_ENDPOINT + functionSelector)
      const signatureData = await signatureResponse.json()

      console.log('===========')
      console.log('CACHE THIS:', signatureData)
      console.log('===========')

      for (const signatureResult of signatureData.results) {
        lookupResults.push(signatureResult.text_signature)
      }
    }

    for (const possibleSignature of lookupResults) {
      console.log('-', possibleSignature)
      const candidate = {
        signature: possibleSignature,
        parameters: [] as ethers.utils.Result,
      }

      const parameters = extractParametersFromSignature(possibleSignature)

      let decoded
      try {
        decoded = ethers.utils.defaultAbiCoder.decode(parameters, '0x' + data)
      } catch (error) {
        console.log('error decoding call', error)
        continue
      }

      for (const [index, parameter] of parameters.entries()) {
        candidate.parameters.push({
          type: parameter,
          value: decoded[index],
        })
      }
      candidates.push(candidate)
      // console.log('found candidate', candidate)
    }
    result.push(candidates)
  }

  return result
}

function decodeCommands(commands: string, inputs: string[]): Multicall['calls'] {
  const result: Multicall['calls'] = []

  const commandArray = commands.slice(2).split(/(?=(?:..)*$)/)
  let index = 0
  for (const command of commandArray) {
    const input = inputs[index]
    index++
    if (command in commandLookup) {
      const signature = commandLookup[command]

      const call = {
        signature: signature,
        parameters: [] as ethers.utils.Result,
      }

      const parameters = extractParametersFromSignature(signature)
      console.log(parameters)

      let decoded
      try {
        decoded = ethers.utils.defaultAbiCoder.decode(parameters, input)
      } catch (error) {
        console.log('error decoding call', error)
        continue
      }

      for (const [index, parameter] of parameters.entries()) {
        call.parameters.push({
          type: parameter,
          value: decoded[index],
        })
      }

      result.push([call])
      // const output
      // const commandInterface = new ethers.utils.Interface([`function f${functionArgs}`])
    } else {
      console.log('unknown command', command)
    }
  }

  return result
}

/**
 * Decodes a multicall.
 */
export async function decodeRaw(calldata: string): Promise<Multicall | undefined> {
  const functionSelector = calldata.slice(0, 10) // first four bytes are the function selector

  const signature = 'multicall(uint256 deadline, bytes[] calls)'
  const multicallInterface = new ethers.utils.Interface([`function ${signature}`])
  const sighash = multicallInterface.getSighash(signature)

  if (functionSelector === sighash) {
    const {
      args: [deadline, calls],
    } = multicallInterface.parseTransaction({ data: calldata })
    const decodedCalls = await decodeCalls(calls)

    return {
      deadline,
      calls: decodedCalls,
    }
  }
}

export async function decodeUniversalRaw(calldata: string): Promise<Multicall | undefined> {
  const functionSelector = calldata.slice(0, 10) // first four bytes are the function selector

  const signature = 'execute(bytes commands,bytes[] inputs,uint256 deadline)'
  const executeInterface = new ethers.utils.Interface([`function ${signature}`])
  const sighash = executeInterface.getSighash(signature)

  if (functionSelector === sighash) {
    const {
      args: [commands, inputs, deadline],
    } = executeInterface.parseTransaction({ data: calldata })
    const decodedCommands = await decodeCommands(commands, inputs)

    return {
      deadline,
      calls: decodedCommands,
    }
  }
}
