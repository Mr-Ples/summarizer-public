import type { Route } from "./+types/api.continue"
import * as schema from "~/database/schema"
import { eq } from "drizzle-orm"

interface Section {
  title: string
  start_page: number
  end_page: number
  start_text?: string
  end_text?: string
}

// Import helper functions from api.process.tsx
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Parse retry delay from API error response
function parseRetryDelay(errorText: string): number {
  try {
    const errorData = JSON.parse(errorText)
    const retryInfo = errorData.error?.details?.find(
      (detail: any) =>
        detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    )
    if (retryInfo?.retryDelay) {
      const delayString = retryInfo.retryDelay
      const seconds = parseInt(delayString.replace("s", ""))
      return seconds * 1000 // Convert to milliseconds
    }
  } catch (e) {
    console.log("[RETRY] Could not parse retry delay from error response")
  }
  return 0
}

// Helper function to update document status only
async function updateDocumentStatus(
  db: any,
  documentId: number,
  stepName: string,
  message: string,
  progress?: number
) {
  const updateData: any = {
    currentStep: stepName,
    statusMessage: message,
  }

  if (progress !== undefined) {
    updateData.progress = progress
  }

  await db
    .update(schema.documents)
    .set(updateData)
    .where(eq(schema.documents.id, documentId))
}

// Retry with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  db?: any,
  documentId?: number,
  stepName?: string
): Promise<T> {
  let lastError: Error
  let lastErrorText: string = ""

  console.log(`[RETRY] Starting operation with max ${maxRetries} retries`)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Use retry delay from API response if available, otherwise exponential backoff
        const apiRetryDelay = parseRetryDelay(lastErrorText)
        const delayMs =
          apiRetryDelay > 0
            ? apiRetryDelay
            : baseDelay * Math.pow(2, attempt - 1)

        if (db && documentId && stepName) {
          const waitSeconds = Math.round(delayMs / 1000)
          const message = `Rate limit reached. Waiting ${waitSeconds} seconds before retrying...`
          await updateDocumentStatus(db, documentId, stepName, message)
        }

        console.log(
          `[RETRY] Attempt ${attempt}/${maxRetries}: waiting ${delayMs}ms before retry ${
            apiRetryDelay > 0 ? "(from API response)" : "(exponential backoff)"
          }`
        )
        await delay(delayMs)
      }

      console.log(`[RETRY] Executing attempt ${attempt + 1}/${maxRetries + 1}`)
      const result = await fn()

      if (attempt > 0) {
        console.log(`[RETRY] ✅ Operation succeeded on attempt ${attempt + 1}`)
      }

      return result
    } catch (error) {
      lastError = error as Error
      lastErrorText =
        (error as any).errorText || (error as any).responseText || ""
      console.log(
        `[RETRY] ❌ Attempt ${attempt + 1} failed:`,
        error instanceof Error ? error.message : error
      )

      if (attempt === maxRetries) {
        console.log(
          `[RETRY] ❌ All ${maxRetries + 1} attempts failed. Giving up.`
        )
        break
      }

      // Only retry on rate limit errors
      if (
        error instanceof Error &&
        error.message.includes("Too Many Requests")
      ) {
        console.log(`[RETRY] Rate limit detected, will retry...`)
        continue
      } else {
        console.log(`[RETRY] Non-retryable error, throwing immediately`)
        throw error // Don't retry other errors
      }
    }
  }

  throw lastError!
}

// Section summarization with exact Python prompt
async function createSectionSummary(
  sectionTitle: string,
  sectionContent: string,
  apiKey: string,
  selectedModel: string,
  db: any,
  documentId: number,
  bulletPoints: number = 12
): Promise<string> {
  console.log(
    `[GEMINI-SUMMARY] Starting summary for section: "${sectionTitle}"`
  )
  console.log(
    `[GEMINI-SUMMARY] Content length: ${sectionContent.length} characters`
  )
  console.log(`[GEMINI-SUMMARY] Requested bullet points: ${bulletPoints}`)

  const prompt = `Create a comprehensive bullet point summary of this document section. 

**Section Title:** ${sectionTitle}

**Instructions:**
- Create ${bulletPoints} bullet points that capture the key ideas, concepts, and information
- Each bullet point should be substantive and informative (1-2 sentences)
- Cover the main topics, arguments, findings, or concepts presented
- Maintain the logical flow and structure of the original content
- Use clear, concise language
- Focus on the most important information that someone would need to understand this section

**Format your response as:**
• <First key point with specific details>
• <Second key point with specific details>
• <etc.>

**Section Content:**
${sectionContent}

Create exactly ${bulletPoints} bullet points that comprehensively summarize this section:`

  return await retryWithBackoff(
    async () => {
      console.log(
        `[GEMINI-SUMMARY] Making API call for summary of "${sectionTitle}"`
      )

      // Check if this is a thinking model and disable thinking
      const isThinkingModel = selectedModel.includes("gemini-2.5") && !selectedModel.includes("gemini-2.5-pro")
            
      if (isThinkingModel) {
        console.log(`[GEMINI-SUMMARY] Thinking model detected: ${selectedModel}. Disabling thinking tokens.`)
      }
      
      const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          ...(isThinkingModel && { thinkingConfig: { thinkingBudget: 0 } }),
        },
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel.replace(
          "models/",
          ""
        )}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }
      )

      console.log(
        `[GEMINI-SUMMARY] API response status: ${response.status} ${response.statusText}`
      )

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[GEMINI-SUMMARY] API error response: ${errorText}`)
        const error = new Error(`Gemini API error: ${response.statusText}`)
        ;(error as any).errorText = errorText
        throw error
      }

      const result = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      const summaryText = result.candidates?.[0]?.content?.parts?.[0]?.text

      if (!summaryText) {
        console.error("[GEMINI-SUMMARY] No summary text in response:", result)
        throw new Error("No summary returned from Gemini")
      }

      console.log(
        `[GEMINI-SUMMARY] Summary received (${summaryText.length} chars)`
      )
      console.log(
        `[GEMINI-SUMMARY] Summary preview: ${summaryText.substring(0, 200)}...`
      )

      console.log(
        `[GEMINI-SUMMARY] ✅ Valid summary generated for "${sectionTitle}"`
      )
      return summaryText.trim()
    },
    3,
    1000,
    db,
    documentId,
    "generating_summaries"
  )
}

// Extract content for a specific section from document text
function extractSectionContent(
  documentText: string,
  section: Section,
  nextSection?: Section
): string {
  const lines = documentText.split("\n")
  let sectionContent = ""
  let capturing = false
  let currentPage = 1

  for (const line of lines) {
    // Check for page markers
    const pageMatch = line.match(/=== PAGE (\d+) ===/)
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1])
      continue
    }

    // Start capturing when we reach the section's start page
    if (currentPage >= section.start_page && !capturing) {
      // Look for the section's start text or title
      if (
        line.toLowerCase().includes(section.title.toLowerCase()) ||
        (section.start_text &&
          line.toLowerCase().includes(section.start_text.toLowerCase()))
      ) {
        capturing = true
      }
    }

    // Stop capturing when we reach the next section or end page
    if (capturing) {
      if (currentPage > section.end_page) {
        break
      }

      if (
        nextSection &&
        (line.toLowerCase().includes(nextSection.title.toLowerCase()) ||
          (nextSection.start_text &&
            line.toLowerCase().includes(nextSection.start_text.toLowerCase())))
      ) {
        break
      }

      sectionContent += line + "\n"
    }
  }

  // Fallback: if no content found using title matching, extract by page numbers only
  if (!sectionContent.trim()?.length) {
    console.log(
      `[EXTRACT] No content found using title matching for section "${section.title}". Falling back to page-based extraction.`
    )

    sectionContent = ""
    capturing = false
    currentPage = 1

    for (const line of lines) {
      // Check for page markers
      const pageMatch = line.match(/=== PAGE (\d+) ===/)
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1])
        continue
      }

      // Start capturing at the exact start page
      if (currentPage >= section.start_page && !capturing) {
        capturing = true
      }

      // Stop capturing at the exact end page
      if (capturing) {
        if (currentPage > section.end_page) {
          break
        }
        sectionContent += line + "\n"
      }
    }
  }

  return sectionContent.trim()
}

export async function action({ request, context }: Route.ActionArgs) {
  try {
    // Get API key from query parameters
    const url = new URL(request.url)
    const apiKey = url.searchParams.get("apiKey")

    if (!apiKey) {
      return Response.json({ error: "API key is required" }, { status: 400 })
    }

    const body = (await request.json()) as {
      documentId: number
      selectedModel: string
      fileData: string
      fileName: string
      documentText: string
      updatedTableOfContents?: Section[]
    }

    const {
      documentId,
      selectedModel,
      fileData,
      fileName,
      documentText,
      updatedTableOfContents,
    } = body

    console.log(`[CONTINUE] Starting continuation for document ${documentId}`)

    if (!documentId || !selectedModel || !fileData || !documentText) {
      console.error(`[CONTINUE] Missing required parameters`)
      return Response.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    try {
      console.log(
        `[CONTINUE] Step 1: Resuming processing for document ${documentId}`
      )
      // Verify document is in awaiting approval state
      const document = await context.db.query.documents.findFirst({
        where: (documents, { eq }) => eq(documents.id, documentId),
      })

      if (!document) {
        console.error(`[CONTINUE] Document ${documentId} not found`)
        return Response.json({ error: "Document not found" }, { status: 404 })
      }

      if (document.status !== "awaiting_outline_approval") {
        console.error(
          `[CONTINUE] Document ${documentId} not in awaiting approval state: ${document.status}`
        )
        return Response.json(
          { error: "Document not awaiting approval" },
          { status: 400 }
        )
      }

      console.log(
        `[CONTINUE] Document ${documentId} verified, continuing with summarization`
      )

      // Mark as approved and continue processing
      await context.db
        .update(schema.documents)
        .set({
          status: "processing",
          outlineApprovedAt: new Date(),
        })
        .where(eq(schema.documents.id, documentId))

      // Get the sections from TOC
      const sections =
        updatedTableOfContents ||
        (JSON.parse(document.tableOfContents || "[]") as Section[])
      console.log(
        `[CONTINUE] Processing ${sections.length} sections for summaries`
      )

      console.log(
        `[CONTINUE] Step 6: Starting detailed summary generation for document ${documentId}`
      )

      // Step 6: Generate detailed summaries for each section
      await updateDocumentStatus(
        context.db,
        documentId,
        "generating_summaries",
        "Generating detailed summaries for each section... Processing sections one by one with AI.",
        75
      )

      console.log(
        `[CONTINUE] Starting summary generation for ${sections.length} sections`
      )

      const validSections = []
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        const nextSection = sections[i + 1]

        console.log(
          `[CONTINUE] Processing section ${i + 1}/${sections.length}: "${
            section.title
          }"`
        )

        // Update status at the start of each section
        const initialProgress = 75 + (i / sections.length) * 25
        await updateDocumentStatus(
          context.db,
          documentId,
          "generating_summaries",
          `Processing section ${i + 1}/${sections.length}: ${section.title}`,
          Math.round(initialProgress)
        )

        // Add delay between requests to respect rate limits
        if (i > 0) {
          console.log(
            `[CONTINUE] Rate limiting: waiting 2 seconds before next API call`
          )
          await delay(2000) // 2 second delay between section processing
        }

        console.log(
          `[CONTINUE] Extracting content for section: ${section.title} (pages ${section.start_page}-${section.end_page})`
        )

        // Extract actual section content from document text
        const sectionContent = extractSectionContent(
          documentText,
          section,
          nextSection
        )

        console.log(
          `[CONTINUE] Extracted ${sectionContent.length} characters for section: ${section.title}`
        )
        console.log(
          `[CONTINUE] Sending to Gemini for summarization (12 bullet points requested)`
        )

        // Update status before AI call
        await updateDocumentStatus(
          context.db,
          documentId,
          "generating_summaries",
          `Analyzing section ${i + 1}/${sections.length}: ${
            section.title
          } with AI...`,
          Math.round(75 + (i / sections.length) * 25)
        )

        // Generate summary
        const summary = await createSectionSummary(
          section.title,
          sectionContent,
          apiKey,
          selectedModel,
          context.db,
          documentId
        )

        console.log(
          `[CONTINUE] Summary generated for "${section.title}": ${summary.length} characters`
        )

        console.log(
          `[CONTINUE] Valid section found. Generating PDF for: ${section.title}`
        )

        // Generate actual PDF section with summary page + original pages
        await updateDocumentStatus(
          context.db,
          documentId,
          "generating_pdfs",
          `Generating PDF for section: ${section.title} (${i + 1}/${
            sections.length
          })`,
          Math.round(75 + ((i + 1) / sections.length) * 20)
        )

        console.log(
          `[CONTINUE] Creating PDF for section "${section.title}" with summary + pages ${section.start_page}-${section.end_page}`
        )

        // PDF generation moved to client-side - server just saves section data
        console.log(
          `[CONTINUE] PDF generation moved to client-side. Saving section data to database: ${section.title}`
        )

        // Save section to database without PDF path
        await context.db.insert(schema.sections).values({
          documentId: documentId,
          title: section.title,
          summary: summary,
          startPage: section.start_page,
          endPage: section.end_page,
          sectionNumber: i + 1,
          pdfPath: null, // PDF generation handled client-side
        })

        console.log(`[CONTINUE] Section saved to database successfully`)
        validSections.push(section)

        // Update progress for each section (both valid and junk sections)
        const sectionProgress = 75 + ((i + 1) / sections.length) * 25
        const statusMessage = `Completed section ${i + 1}/${sections.length}: ${
          section.title
        } (summary generated)`

        console.log(
          `[CONTINUE] Section ${i + 1}/${
            sections.length
          } complete. Progress: ${Math.round(sectionProgress)}%`
        )

        await updateDocumentStatus(
          context.db,
          documentId,
          "generating_summaries",
          statusMessage,
          Math.round(sectionProgress)
        )
      }

      console.log(
        `[CONTINUE] All sections processed. Valid sections: ${validSections.length}/${sections.length}`
      )

      await updateDocumentStatus(
        context.db,
        documentId,
        "generating_summaries",
        `All section summaries generated. Successfully processed ${validSections.length} sections.`,
        95
      )

      console.log(
        `[CONTINUE] Step 7: Finalizing document processing for document ${documentId}`
      )

      // Step 7: Finalize
      await updateDocumentStatus(
        context.db,
        documentId,
        "finalizing",
        "Finalizing document processing... Updating final status and completion timestamp.",
        98
      )

      console.log(`[CONTINUE] Updating document status to completed`)
      console.log(
        `[CONTINUE] Final stats - Valid sections: ${validSections.length}, Has TOC: true`
      )

      // Update document status to completed
      await context.db
        .update(schema.documents)
        .set({
          status: "completed",
          currentStep: "completed",
          progress: 100,
          statusMessage: `Processing completed successfully! Generated ${validSections.length} section summaries.`,
          completedAt: new Date(),
        })
        .where(eq(schema.documents.id, documentId))

      console.log(
        `[CONTINUE] ✅ Document ${documentId} processing completed successfully!`
      )

      return Response.json({
        success: true,
        sections: validSections.length,
        hasTableOfContents: true,
      })
    } catch (processingError) {
      console.error(
        `[CONTINUE] ❌ Processing error for document ${documentId}:`,
        processingError
      )
      console.error(
        `[CONTINUE] Error stack:`,
        processingError instanceof Error
          ? processingError.stack
          : "No stack trace"
      )

      // Update document with error status
      await context.db
        .update(schema.documents)
        .set({
          status: "failed",
          errorMessage:
            processingError instanceof Error
              ? processingError.message
              : "Unknown processing error",
        })
        .where(eq(schema.documents.id, documentId))

      console.log(
        `[CONTINUE] Document ${documentId} marked as failed in database`
      )

      return Response.json(
        {
          error: "Processing failed",
          details:
            processingError instanceof Error
              ? processingError.message
              : "Unknown error",
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error("[CONTINUE] ❌ API-level error:", error)
    console.error(
      "[CONTINUE] Error details:",
      error instanceof Error ? error.stack : "No stack trace"
    )
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    )
  }
}
