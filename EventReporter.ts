import { config } from './deps.ts'

const env = config()

export async function reportEvent(message: string) {
  await reportAddressEvent('0x0', message)
}

export default async function reportAddressEvent(address: string, message: string) {
  await fetch(env['EVENT_REPORTER_URL'], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address, message }),
  })
}
