import * as FileSystem from 'expo-file-system/legacy';
import { fetch } from 'expo/fetch';
import { Platform } from 'react-native';
import type { ChatMode } from '@/contexts/ConversationsContext';

interface ChatPayloadMessage {
  role: 'user' | 'assistant';
  content: string;
}

function getApiOrigin() {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain && Platform.OS === 'web') return window.location.origin;
  if (!domain) {
    throw new Error('No se configuró la dirección del servicio de IA.');
  }
  return domain.startsWith('http') ? domain : `https://${domain}`;
}

export async function streamAiReply(
  messages: ChatPayloadMessage[],
  mode: Extract<ChatMode, 'chat' | 'document'>,
  conversationId: string,
  onText: (chunk: string) => void,
) {
  const response = await fetch(`${getApiOrigin()}/api/prisma/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ messages, mode, conversationId }),
  });

  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(result?.error ?? 'No se pudo conectar con Prisma.');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('El servicio no devolvió una respuesta.');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let eventType = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      try {
        const payload = JSON.parse(data) as {
          content?: string;
          error?: string;
        };
        if (eventType === 'error' || payload.error) {
          throw new Error(payload.error ?? 'No se pudo completar la respuesta.');
        }
        if (payload.content) {
          fullText += payload.content;
          onText(payload.content);
        }
      } catch (error) {
        if (error instanceof Error && error.message !== 'Unexpected end of JSON input') {
          throw error;
        }
      } finally {
        eventType = 'message';
      }
    }
  }

  const remainder = buffer.trim();
  if (remainder.startsWith('data:')) {
    const data = remainder.slice(5).trim();
    if (data && data !== '[DONE]') {
      const payload = JSON.parse(data) as { content?: string; error?: string };
      if (payload.error) throw new Error(payload.error);
      if (payload.content) {
        fullText += payload.content;
        onText(payload.content);
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error('Prisma no devolvió contenido. Inténtalo otra vez.');
  }
  return fullText;
}

export async function saveGeneratedImage(base64: string, imageId: string) {
  if (Platform.OS === 'web') return `data:image/png;base64,${base64}`;
  const directory = FileSystem.documentDirectory;
  if (!directory) throw new Error('No se pudo abrir el almacenamiento del teléfono.');
  const uri = `${directory}prisma-${imageId}.png`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
  return uri;
}
