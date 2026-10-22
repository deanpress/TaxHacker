import { NextRequest, NextResponse } from "next/server"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { prisma } from "@/lib/db"
import { codeFromName } from "@/lib/utils"
import { getUserUploadsDirectory, safePathJoin, unsortedFilePath } from "@/lib/files"
import { getOrCreateSelfHostedUser } from "@/models/users"
import { createFile } from "@/models/files"
import { createProject, getProjectByCode } from "@/models/projects"
import { createCategory, getCategoryByCode } from "@/models/categories"

/**
 * Karen import shim.
 *
 * POST /api/import/transaction
 * Auth:  X-API-Key (or Authorization: Bearer) === process.env.TAXHACKER_IMPORT_KEY
 * Body:  multipart/form-data — `file` (binary receipt/invoice) + `data` (JSON)
 *        data: { externalId, merchant?, amount (number), currency?, date? (ISO),
 *                project?, category?, note? }
 *
 * Creates a Transaction with the file attached. Idempotent on `externalId`
 * (stored in Transaction.extra.externalId). Resolves/creates the named Project
 * and Category by code. Owner is the single self-hosted user.
 */

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
}

function bad(error: string) {
  return NextResponse.json({ success: false, error }, { status: 400 })
}

async function resolveProjectCode(userId: string, name?: string): Promise<string | undefined> {
  if (!name || !name.trim()) return undefined
  const code = codeFromName(name)
  const existing = await getProjectByCode(userId, code)
  if (!existing) {
    await createProject(userId, { code, name: name.trim() })
  }
  return code
}

async function resolveCategoryCode(userId: string, name?: string): Promise<string | undefined> {
  if (!name || !name.trim()) return undefined
  const code = codeFromName(name)
  const existing = await getCategoryByCode(userId, code)
  if (!existing) {
    await createCategory(userId, { code, name: name.trim() })
  }
  return code
}

export async function POST(request: NextRequest) {
  const expectedKey = process.env.TAXHACKER_IMPORT_KEY
  if (!expectedKey) {
    return NextResponse.json(
      { success: false, error: "TAXHACKER_IMPORT_KEY not configured on server" },
      { status: 500 }
    )
  }

  const providedKey =
    request.headers.get("x-api-key") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""
  if (providedKey !== expectedKey) {
    return unauthorized()
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return bad("Expected multipart/form-data")
  }

  const file = form.get("file")
  const dataRaw = form.get("data")
  if (!(file instanceof File)) return bad("Missing `file`")
  if (typeof dataRaw !== "string") return bad("Missing `data` JSON")

  let data: {
    externalId?: string
    merchant?: string
    amount?: number
    currency?: string
    date?: string
    project?: string
    category?: string
    note?: string
  }
  try {
    data = JSON.parse(dataRaw)
  } catch {
    return bad("`data` is not valid JSON")
  }

  if (!data.externalId) return bad("`externalId` is required for idempotency")
  if (typeof data.amount !== "number" || !isFinite(data.amount) || data.amount <= 0) {
    return bad("`amount` must be a positive number")
  }

  const user = await getOrCreateSelfHostedUser()

  // Idempotency: return the existing transaction if this externalId was filed before.
  const existing = await prisma.transaction.findFirst({
    where: { userId: user.id, extra: { path: ["externalId"], equals: data.externalId } },
  })
  if (existing) {
    const existingFiles = Array.isArray(existing.files) ? (existing.files as string[]) : []
    return NextResponse.json({
      success: true,
      transactionId: existing.id,
      fileId: existingFiles[0],
      idempotent: true,
    })
  }

  // Persist the uploaded file under the user's uploads directory.
  const fileUuid = randomUUID()
  const filename = file.name || `${fileUuid}`
  const relativeFilePath = unsortedFilePath(fileUuid, filename)
  const fullFilePath = safePathJoin(getUserUploadsDirectory(user), relativeFilePath)
  const buffer = Buffer.from(await file.arrayBuffer())
  await mkdir(path.dirname(fullFilePath), { recursive: true })
  await writeFile(fullFilePath, buffer)

  const fileRecord = await createFile(user.id, {
    id: fileUuid,
    filename,
    path: relativeFilePath,
    mimetype: file.type || "application/octet-stream",
    isReviewed: true,
  })

  const projectCode = await resolveProjectCode(user.id, data.project)
  const categoryCode = await resolveCategoryCode(user.id, data.category)

  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      name: data.merchant || filename,
      merchant: data.merchant || null,
      total: Math.round(data.amount * 100), // cents
      currencyCode: (data.currency || "USD").toUpperCase(),
      type: "expense",
      issuedAt: data.date ? new Date(data.date) : null,
      note: data.note || null,
      categoryCode: categoryCode ?? null,
      projectCode: projectCode ?? null,
      items: [],
      files: [fileRecord.id],
      extra: { externalId: data.externalId, source: "karen" },
    },
  })

  return NextResponse.json({
    success: true,
    transactionId: transaction.id,
    fileId: fileRecord.id,
  })
}
