import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useState, type RefObject } from 'react';
import { useColors } from '@/hooks/useColors';
import type { ChatMode } from '@/contexts/ConversationsContext';
import type { PrismaImageAttachment } from '@/lib/ai';

export interface SelectedPrismaImage extends PrismaImageAttachment {
  uri: string;
}

interface ChatComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  onSend: (attachment: SelectedPrismaImage | null) => void;
  isBusy: boolean;
  inputRef: RefObject<TextInput | null>;
}

const modes: Array<{
  id: ChatMode;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
  { id: 'image', label: 'Imagen', icon: 'image-outline' },
  { id: 'document', label: 'Documento', icon: 'document-text-outline' },
];

function normalizeMimeType(value?: string | null): PrismaImageAttachment['mimeType'] | null {
  const mime = value?.toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/webp') return 'image/webp';
  return null;
}

export default function ChatComposer({
  value,
  onChangeText,
  mode,
  onModeChange,
  onSend,
  isBusy,
  inputRef,
}: ChatComposerProps) {
  const colors = useColors();
  const [attachment, setAttachment] = useState<SelectedPrismaImage | null>(null);
  const [attachmentError, setAttachmentError] = useState('');
  const placeholder =
    mode === 'image'
      ? 'Describe la imagen que imaginas…'
      : mode === 'document'
        ? '¿Qué documento necesitas?'
        : attachment
          ? '¿Qué querés saber de esta imagen?'
          : 'Escribe tu mensaje…';
  const canSend = !isBusy && (!!value.trim() || !!attachment);

  async function pickImage() {
    if (isBusy) return;
    setAttachmentError('');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      base64: true,
      quality: 0.72,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64 || !asset.uri) {
      setAttachmentError('No se pudo leer esa imagen.');
      return;
    }
    if (asset.base64.length > 6_500_000) {
      setAttachmentError('La imagen es demasiado grande. Elegí una más liviana.');
      return;
    }
    const mimeType = normalizeMimeType(asset.mimeType);
    if (!mimeType) {
      setAttachmentError('Prisma acepta imágenes JPG, PNG o WebP.');
      return;
    }
    onModeChange('chat');
    setAttachment({ uri: asset.uri, data: asset.base64, mimeType });
  }

  function sendCurrent() {
    if (!canSend) return;
    const currentAttachment = attachment;
    setAttachment(null);
    setAttachmentError('');
    onSend(currentAttachment);
  }

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
      ]}
    >
      <View style={styles.modeRow}>
        {modes.map((item) => {
          const selected = mode === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              testID={`mode-${item.id}`}
              disabled={isBusy}
              onPress={() => {
                if (item.id === 'image') setAttachment(null);
                onModeChange(item.id);
              }}
              style={({ pressed }) => [
                styles.modeButton,
                {
                  backgroundColor: selected ? colors.accent : 'transparent',
                  opacity: pressed ? 0.76 : 1,
                },
              ]}
            >
              <Ionicons
                name={item.icon}
                size={15}
                color={selected ? colors.accentForeground : colors.mutedForeground}
              />
              <Text
                style={[
                  styles.modeLabel,
                  {
                    color: selected
                      ? colors.accentForeground
                      : colors.mutedForeground,
                  },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {attachment ? (
        <View style={styles.attachmentRow}>
          <Image source={{ uri: attachment.uri }} style={styles.attachmentPreview} />
          <View style={styles.attachmentMeta}>
            <Text style={[styles.attachmentTitle, { color: colors.foreground }]}>Imagen adjunta</Text>
            <Text style={[styles.attachmentHint, { color: colors.mutedForeground }]}>Prisma la analizará con visión</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quitar imagen"
            onPress={() => setAttachment(null)}
            style={[styles.removeAttachment, { backgroundColor: colors.secondary }]}
          >
            <Ionicons name="close" size={17} color={colors.secondaryForeground} />
          </Pressable>
        </View>
      ) : null}

      {attachmentError ? (
        <Text style={[styles.attachmentError, { color: colors.destructive }]}>{attachmentError}</Text>
      ) : null}

      <View
        style={[
          styles.inputShell,
          { backgroundColor: colors.card, borderColor: colors.input },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Adjuntar imagen"
          testID="attach-image"
          disabled={isBusy || mode === 'image'}
          onPress={() => void pickImage()}
          style={({ pressed }) => [
            styles.attachButton,
            {
              opacity: isBusy || mode === 'image' ? 0.35 : pressed ? 0.65 : 1,
            },
          ]}
        >
          <Ionicons name="attach" size={21} color={colors.mutedForeground} />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={4000}
          blurOnSubmit={false}
          returnKeyType="send"
          onSubmitEditing={sendCurrent}
          editable={!isBusy}
          selectionColor={colors.primary}
          accessibilityLabel={placeholder}
          testID="chat-input"
          style={[styles.input, { color: colors.foreground }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isBusy ? 'Generando respuesta' : 'Enviar'}
          testID="send-message"
          disabled={!canSend}
          onPress={sendCurrent}
          style={({ pressed }) => [
            styles.sendButton,
            {
              backgroundColor: canSend ? colors.primary : colors.muted,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Ionicons
            name={isBusy ? 'ellipsis-horizontal' : 'arrow-up'}
            size={20}
            color={canSend ? colors.primaryForeground : colors.mutedForeground}
          />
        </Pressable>
      </View>
      <Text style={[styles.disclaimer, { color: colors.mutedForeground }]}>
        Revisa la información importante antes de usarla.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 9,
  },
  modeButton: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    borderRadius: 12,
  },
  modeLabel: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 9,
  },
  attachmentPreview: {
    width: 52,
    height: 52,
    borderRadius: 12,
  },
  attachmentMeta: {
    flex: 1,
  },
  attachmentTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
  attachmentHint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    marginTop: 2,
  },
  removeAttachment: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentError: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    marginBottom: 8,
  },
  inputShell: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  attachButton: {
    width: 36,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    maxHeight: 118,
    minHeight: 38,
    paddingHorizontal: 7,
    paddingTop: 9,
    paddingBottom: 8,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 21,
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 5,
  },
  disclaimer: {
    textAlign: 'center',
    paddingVertical: 9,
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
  },
});