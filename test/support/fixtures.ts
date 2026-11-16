import { EventEmitter } from 'node:events';
import type { BotIdentity, GrytBotOptions, Message, ServerInfo } from '@gryt/bot';
import { loadConfig } from '../../src/config.ts';
import type { GrytClient } from '../../src/gryt.ts';

export const env = {
  GRYT_HOST: 'https://chat.example.com', GRYT_NICKNAME: 'Assistant',
  GRYT_ALLOWED_CHANNEL_ID: 'allowed', GRYT_IDENTITY_PATH: './unused-test-identity.json',
  LLM_BASE_URL: 'https://llm.example.com/v1', LLM_MODEL: 'answer-model',
  LLM_API_KEY: 'test-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024',
};
export const config = (overrides: NodeJS.ProcessEnv = {}) => loadConfig({ ...env, ...overrides });
export const identity: BotIdentity = {
  subject: 'BOT_test', certificate: async () => 'test-certificate', assertion: async () => 'test-assertion',
};
export const message = (overrides: Partial<Message> = {}): Message => ({
  conversationId: 'allowed', messageId: '1', senderServerUserId: 'user-1',
  senderNickname: 'User', text: '[@Assistant](mention:bot-1) hello', attachments: [],
  createdAt: new Date(), editedAt: null, replyToMessageId: null, threadId: null,
  isOwn: false, isSystem: false, ...overrides,
});
export const joined = (claims: unknown = { serverUserId: 'bot-1' }) => ({
  accessToken: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
});

export class FakeBot extends EventEmitter {
  socket: EventEmitter | null = new EventEmitter();
  permissions = ['read_messages', 'send_messages'];
  channels: { id: string; name: string; type: 'text' | 'voice' }[] = [{ id: 'allowed', name: 'General', type: 'text' }];
  options?: GrytBotOptions;
  stopCount = 0;
  startCount = 0;
  sent: string[] = [];
  private entered!: () => void;
  readonly started = new Promise<void>((resolve) => { this.entered = resolve; });
  ready!: (info: ServerInfo) => void;
  fail!: (error: Error) => void;
  private readonly connection = new Promise<ServerInfo>((resolve, reject) => {
    this.ready = resolve;
    this.fail = reject;
  });
  start() { this.startCount++; this.entered(); return this.connection; }
  async stop() { this.stopCount++; }
  async send(_channel: string, text: string) { this.sent.push(text); return message({ text }); }
  typing() {}
  stopTyping() {}
  connect() {
    this.socket?.emit('server:joined', joined());
    const info = { name: 'Test', serverId: 'test', description: '', permissions: this.permissions, role: 'bot' };
    this.emit('ready', info);
    this.ready(info);
  }
  // EventEmitter stands in for Socket.IO; it implements the events used by the adapter.
  create = (options: GrytBotOptions): GrytClient => {
    this.options = options;
    return this as unknown as GrytClient;
  };
}
