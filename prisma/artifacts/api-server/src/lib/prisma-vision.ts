import {
  type AiProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "./ai-provider";

export type PrismaImageInput = {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

export async function analyzePrismaImage(
  provider: AiProviderConfig,
  image: PrismaImageInput,
  userText: string,
) {
  const prompt = userText.trim() ||
    "Analiza esta imagen con detalle. Describe lo importante para poder responder y actuar sobre lo que muestra.";

  const response = await fetch(
    getProviderEndpoint(provider.baseUrl, "chat/completions"),
    {
      method: "POST",
      headers: getProviderHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${prompt}\n\nPrimero interpreta fielmente la imagen. Señala textos, errores, pantallas, controles o detalles visuales que puedan ser relevantes. No inventes elementos que no veas.`,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.data}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1200,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Prisma no pudo analizar la imagen (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("El modelo de visión no devolvió una lectura de la imagen.");
  }
  return content.trim();
}
