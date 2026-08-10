import { prisma } from "@/lib/prisma";

// One ChatSession per Dataset (docs/02-data-model.md, docs/04's "appended
// to the existing ChatSession rather than starting a new one") — every
// caller that needs "the chat for this dataset" goes through this rather
// than creating its own, so re-cleans, on-demand audits, and the actual
// chat page all land in the same conversation.
export async function findOrCreateChatSession(userId: string, datasetId: string) {
  const existing = await prisma.chatSession.findFirst({ where: { datasetId, userId } });
  if (existing) return existing;
  return prisma.chatSession.create({ data: { userId, datasetId } });
}
