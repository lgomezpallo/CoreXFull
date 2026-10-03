import { Ionicons } from '@expo/vector-icons';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RefObject } from 'react';
import { useColors } from '@/hooks/useColors';
import type { ChatMode } from '@/contexts/ConversationsContext';

interface ChatComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  onSend: () => void;
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
  const placeholder =
    mode === 'image'
      ? 'Describe la imagen que imaginas…'
      : mode === 'document'
        ? '¿Qué documento necesitas?'
        : 'Escribe tu mensaje…';

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
              onPress={() => onModeChange(item.id)}
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

      <View
        style={[
          styles.inputShell,
          { backgroundColor: colors.card, borderColor: colors.input },
        ]}
      >
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
          onSubmitEditing={onSend}
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
          disabled={isBusy || !value.trim()}
          onPress={onSend}
          style={({ pressed }) => [
            styles.sendButton,
            {
              backgroundColor:
                isBusy || !value.trim() ? colors.muted : colors.primary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Ionicons
            name={isBusy ? 'ellipsis-horizontal' : 'arrow-up'}
            size={20}
            color={
              isBusy || !value.trim()
                ? colors.mutedForeground
                : colors.primaryForeground
            }
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
  inputShell: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 7,
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