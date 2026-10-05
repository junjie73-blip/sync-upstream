import type { SyncConfig, WebhookDelivery } from '../domain'
import process from 'node:process'
import { toError } from '../errors'
import { logger } from '../logger'
import { runSync } from '../sync'
import { WebhookServer } from '../webhook'

/**
 * Daemon mode: keep listening and run one sync per accepted delivery.
 * A failing sync is logged and does not take the server down.
 */
export async function serveWebhooks(config: SyncConfig): Promise<number> {
  const webhookConfig = config.webhookConfig
  if (!webhookConfig?.enable) {
    logger.warn('webhookConfig.enable 为 false，未启动监听')
    return 0
  }

  const server = new WebhookServer(webhookConfig, {
    onSync: async (delivery: WebhookDelivery) => {
      logger.info(`收到 ${delivery.platform} ${delivery.event} (${delivery.branch})，开始同步`)
      try {
        await runSync({ config: { ...config, nonInteractive: true, autoPush: config.autoPush } })
      }
      catch (error) {
        logger.error(`Webhook 触发的同步失败: ${toError(error).message}`, toError(error))
      }
    },
  })

  const { port } = await server.start()
  logger.success(`Webhook 服务已启动: http://0.0.0.0:${port}${webhookConfig.path}（Ctrl+C 退出）`)

  await waitForShutdown()
  await server.stop()
  logger.info('Webhook 服务已停止')
  return 0
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve()
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
