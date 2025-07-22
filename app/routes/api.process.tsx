import type { Route } from "./+types/api.process"
import * as schema from "~/database/schema"
import { eq } from "drizzle-orm"
import { fetchAvailableModels } from "~/lib/ai-client"
import type { AIModel } from "~/lib/ai-client"
import { generateContent, type GenerateContentRequest } from "~/lib/ai-client"

interface Section {
  title: string
  start_page: number
  end_page: number
  start_text?: string
  end_text?: string
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

async function updatePDFMetadata(
  db: any,
  documentId: number,
  pdfTitle?: string,
  pdfAuthor?: string
) {
  const updateData: any = {}
  
  if (pdfTitle) {
    updateData.pdfTitle = pdfTitle
  }
  
  if (pdfAuthor) {
    updateData.pdfAuthor = pdfAuthor
  }

  if (Object.keys(updateData).length > 0) {
    await db
      .update(schema.documents)
      .set(updateData)
      .where(eq(schema.documents.id, documentId))
    
    console.log(`[PROCESS] Updated PDF metadata for document ${documentId}:`, updateData)
  }
}

// Chunk text for large documents (mimicking Python script chunking)
function chunkTextForProcessing(
  text: string,
  maxTokens: number = 14000
): string[] {
  // Simple chunking by character count (approximates token limits)
  // In production, you'd use a proper tokenizer
  // Adjusted to be more conservative for TPM limits: 1 token ≈ 1 char
  const maxChars = maxTokens

  if (text.length <= maxChars) {
    return [text]
  }

  const chunks = []
  let currentChunk = ""
  const lines = text.split("\n")

  for (const line of lines) {
    if ((currentChunk + line).length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      currentChunk = line + "\n"
    } else {
      currentChunk += line + "\n"
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

// Rate limiting helper
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

// Structure analysis with exact Python prompt
async function analyzeDocumentStructure(
  documentText: string,
  apiKey: string,
  selectedModel: string,
  db: any,
  documentId: number,
  chunkNumber: number = 1,
  totalChunks: number = 1
): Promise<Section[]> {
  console.log(
    `[GEMINI-STRUCTURE] Starting structure analysis for chunk ${chunkNumber}/${totalChunks}`
  )
  console.log(`[GEMINI-STRUCTURE] Model: ${selectedModel}`)
  console.log(
    `[GEMINI-STRUCTURE] Text length: ${documentText.length} characters`
  )

  const chunkInfo =
    totalChunks > 1 ? ` (chunk ${chunkNumber}/${totalChunks})` : ""

  const prompt = `You are creating a TABLE OF CONTENTS for this document${chunkInfo}. 

The document contains page markers like "=== PAGE X ===" to help you locate content.

Your task is to generate a comprehensive table of contents that includes:
1. Main sections (chapters, major parts)
2. Subsections within each main section
3. All significant headings and structural divisions

Look specifically for:
- Numbered sections (1., 2., 3. or Chapter 1, Chapter 2, etc.)
- Clear headings in larger/bold text
- Subsection markers (1.1, 1.2, 2.1, etc.)
- Standard academic paper structure: Abstract, Introduction, Literature Review, Methodology, Results, Discussion, Conclusion, References
- Table of contents if one exists in the document
- Any hierarchical organization the author used

For each section/subsection you identify, provide:
- The exact title/heading as it appears in the document
- The page number where it starts (look for "=== PAGE X ===" markers)
- The page number where it ends (before next section starts)
- For "start_text", provide the first ~5 words of the section.
- For "end_text", provide the last ~5 words of the section.

IMPORTANT GUIDELINES:
- Include both main sections AND subsections in your table of contents
- Be conservative: only include sections with clear, visible headings
- Use the exact titles/headings as they appear in the document
- "start_text" and "end_text" should be very short, just a few words to provide context.
- Pay close attention to page markers to get accurate page numbers
- If you can't find clear structural divisions, return fewer sections rather than inventing them
- you don't have to include references or acknowledgements as sections
- don't use non existent page numbers, only use the numbers you are given

Format your response as a JSON list like this:
[
  {
    "title": "Abstract", 
    "start_page": 1,
    "end_page": 1,
    "start_text": "Abstract",
    "end_text": "Introduction"
  },
  {
    "title": "1. Introduction",
    "start_page": 2, 
    "end_page": 5,
    "start_text": "1. Introduction",
    "end_text": "2. Related Work"
  },
  {
    "title": "1.1 Problem Statement",
    "start_page": 3,
    "end_page": 4,
    "start_text": "1.1 Problem Statement",
    "end_text": "1.2 Contributions"
  }
]

Document to analyze:

${documentText}

Return ONLY the JSON array, no other text.`

  return await retryWithBackoff(
    async () => {
      await updateDocumentStatus(
        db,
        documentId,
        "analyzing_structure",
        `[Chunk ${chunkNumber}/${totalChunks}] Calling Gemini for structure analysis...`
      )

      const request: GenerateContentRequest = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      }

      let result = await generateContent(selectedModel, apiKey, request)
      let analysisText = result.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
      let finishReason = result.candidates?.[0]?.finishReason

      if (finishReason === "MAX_TOKENS") {
        console.log(
          `[GEMINI-STRUCTURE] Response truncated, attempting to continue...`
        )
        await updateDocumentStatus(
          db,
          documentId,
          "analyzing_structure",
          `[Chunk ${chunkNumber}/${totalChunks}] Response truncated, continuing...`
        )

        const continuationPrompt = `The previous response was cut off. Please continue generating the JSON from where you left off. Do not repeat the part that was already generated.

Partial JSON:
${analysisText}

Continue the JSON response:`

        const continuationRequest: GenerateContentRequest = {
          contents: [{ parts: [{ text: continuationPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }

        const continuationResult = await generateContent(
          selectedModel,
          apiKey,
          continuationRequest
        )
        const continuedText =
          continuationResult.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
        analysisText += continuedText
      }

      if (!analysisText) {
        console.error(
          "[GEMINI-STRUCTURE] No analysis text in response:",
          result
        )
        throw new Error("No analysis returned from Gemini")
      }

      console.log(
        `[GEMINI-STRUCTURE] Analysis text length: ${analysisText.length} characters`
      )
      console.log(
        `[GEMINI-STRUCTURE] Analysis preview: ${analysisText.substring(
          0,
          300
        )}...`
      )

      // Clean the response by removing markdown fences
      const cleanedText = analysisText.replace(/```json\n|```/g, "").trim()

      // Parse JSON from response
      const jsonMatch = cleanedText.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.error(
          "[GEMINI-STRUCTURE] No JSON array found in response:",
          cleanedText
        )
        throw new Error("No valid JSON found in response")
      }

      console.log(`[GEMINI-STRUCTURE] Found JSON, parsing...`)
      const sections = JSON.parse(jsonMatch[0]) as Section[]
      await updateDocumentStatus(
        db,
        documentId,
        "analyzing_structure",
        `[Chunk ${chunkNumber}/${totalChunks}] Successfully parsed ${sections.length} sections.`
      )

      return sections
    },
    3,
    1000,
    db,
    documentId,
    "analyzing_structure"
  )
}

// // Section summarization with exact Python prompt
// async function createSectionSummary(
//   sectionTitle: string,
//   sectionContent: string,
//   apiKey: string,
//   selectedModel: string,
//   db: any,
//   documentId: number,
//   bulletPoints: number = 12
// ): Promise<string> {
//   console.log(
//     `[GEMINI-SUMMARY] Starting summary for section: "${sectionTitle}"`
//   )
//   console.log(
//     `[GEMINI-SUMMARY] Content length: ${sectionContent.length} characters`
//   )
//   console.log(`[GEMINI-SUMMARY] Requested bullet points: ${bulletPoints}`)

//   const prompt = `Create a comprehensive bullet point summary of this document section. 

// **Section Title:** ${sectionTitle}

// **Instructions:**
// - Create ${bulletPoints} bullet points that capture the key ideas, concepts, and information
// - Each bullet point should be substantive and informative (1-2 sentences)
// - Cover the main topics, arguments, findings, or concepts presented
// - Maintain the logical flow and structure of the original content
// - Use clear, concise language
// - Focus on the most important information that someone would need to understand this section

// **Format your response as:**
// • <First key point with specific details>
// • <Second key point with specific details>
// • <etc.>


// **Section Content:**
// ${sectionContent}

// Create exactly ${bulletPoints} bullet points that comprehensively summarize this section:`

//   return await retryWithBackoff(
//     async () => {
//       console.log(
//         `[GEMINI-SUMMARY] Making API call for summary of "${sectionTitle}"`
//       )

//       const response = await fetch(
//         `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
//         {
//           method: "POST",
//           headers: { "Content-Type": "application/json" },
//           body: JSON.stringify({
//             contents: [{ parts: [{ text: prompt }] }],
//             generationConfig: {
//               temperature: 0.3,
//               maxOutputTokens: 2048,
//             },
//           }),
//         }
//       )

//       console.log(
//         `[GEMINI-SUMMARY] API response status: ${response.status} ${response.statusText}`
//       )

//       if (!response.ok) {
//         const errorText = await response.text()
//         console.error(`[GEMINI-SUMMARY] API error response: ${errorText}`)
//         const error = new Error(`Gemini API error: ${response.statusText}`)
//         ;(error as any).errorText = errorText
//         throw error
//       }

//       const result = (await response.json()) as {
//         candidates?: { content?: { parts?: { text?: string }[] } }[]
//       }
//       const summaryText = result.candidates?.[0]?.content?.parts?.[0]?.text

//       if (!summaryText) {
//         console.error("[GEMINI-SUMMARY] No summary text in response:", result)
//         throw new Error("No summary returned from Gemini")
//       }

//       console.log(
//         `[GEMINI-SUMMARY] Summary received (${summaryText.length} chars)`
//       )
//       console.log(
//         `[GEMINI-SUMMARY] Summary preview: ${summaryText.substring(0, 200)}...`
//       )

//       console.log(
//         `[GEMINI-SUMMARY] ✅ Valid summary generated for "${sectionTitle}"`
//       )
//       return summaryText.trim()
//     },
//     3,
//     1000,
//     db,
//     documentId,
//     "generating_summaries"
//   )
// }

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
      customTableOfContents?: Section[]
      pdfTitle?: string
      pdfAuthor?: string
    }

    const {
      documentId,
      selectedModel,
      fileData,
      fileName,
      documentText,
      customTableOfContents,
      pdfTitle,
      pdfAuthor,
    } = body

    console.log(`[PROCESS] Starting processing for document ${documentId}`)
    console.log(`[PROCESS] - File: ${fileName}`)
    console.log(`[PROCESS] - Model: ${selectedModel}`)
    console.log(`[PROCESS] - API Key length: ${apiKey?.length || 0} characters`)
    console.log(
      `[PROCESS] - File data size: ${fileData?.length || 0} base64 characters`
    )
    console.log(
      `[PROCESS] - Document text provided: ${!!documentText} (${
        documentText?.length || 0
      } characters)`
    )

    if (!documentId || !apiKey || !selectedModel || !fileData) {
      console.error(`[PROCESS] Missing required parameters:`, {
        documentId: !!documentId,
        apiKey: !!apiKey,
        selectedModel: !!selectedModel,
        fileData: !!fileData,
        documentText: !!documentText,
      })
      return Response.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    try {
      console.log(
        `[PROCESS] Step 1: Initializing processing for document ${documentId}`
      )

      // Step 1: Initialize processing
      await updateDocumentStatus(
        context.db,
        documentId,
        "initializing",
        "Starting AI analysis... Text extraction completed on client side.",
        25
      )

      // Update PDF metadata if available
      if (pdfTitle || pdfAuthor) {
        await updatePDFMetadata(context.db, documentId, pdfTitle, pdfAuthor)
      }

      // Use client-provided document text (already extracted)
      if (!documentText) {
        throw new Error(
          "Document text not provided from client-side extraction"
        )
      }

      console.log(
        `[PROCESS] Using client-extracted text: ${documentText.length} characters`
      )
      console.log(
        `[PROCESS] Sample text (first 200 chars): ${documentText.substring(
          0,
          200
        )}...`
      )

      await updateDocumentStatus(
        context.db,
        documentId,
        "extracting_text",
        `Text extraction completed on client side. Extracted ${Math.round(
          documentText.length / 1000
        )}k characters from PDF.`,
        30
      )

      console.log(
        `[PROCESS] Step 3: Starting document chunking analysis for document ${documentId}`
      )

      // Step 3: Get model token limits and chunk document if necessary
      await updateDocumentStatus(
        context.db,
        documentId,
        "chunking_document",
        "Fetching model token limits and analyzing document size...",
        35
      )

      console.log(`[PROCESS] Fetching model token limits for ${selectedModel}`)

      let modelInfo: AIModel | undefined
      try {
        const availableModels = await fetchAvailableModels(apiKey)
        modelInfo = availableModels.find((m) => m.name === selectedModel)
        // if (modelInfo) {
        //   console.log(`[PROCESS] Using model's limits: Input Tokens=${modelInfo.inputTokenLimit}, TPM=${modelInfo.tokensPerMinute}`);
        // } else {
        //   console.log(`[PROCESS] Model info not found for ${selectedModel}, using defaults.`);
        // }
      } catch (error) {
        console.log(
          `[PROCESS] Failed to fetch model limits, using default values.`
        )
      }

      // Use TPM for chunking if available, otherwise fallback to a safe default
      const chunkTokenLimit = modelInfo?.tokensPerMinute ?? 15000 // Fallback to lowest Gemma TPM

      console.log(
        `[PROCESS] Analyzing document for chunking (${documentText.length} characters)`
      )
      console.log(
        `[PROCESS] Using token limit for chunking: ${chunkTokenLimit} tokens (TPM-based)`
      )

      const textChunks = chunkTextForProcessing(documentText, chunkTokenLimit)
      const isMultiChunk = textChunks.length > 1

      console.log(`[PROCESS] Chunking result: ${textChunks.length} chunks`)
      if (isMultiChunk) {
        console.log(
          `[PROCESS] Chunk sizes:`,
          textChunks.map((chunk, i) => `Chunk ${i + 1}: ${chunk.length} chars`)
        )
      }
      await updateDocumentStatus(
        context.db,
        documentId,
        "chunking_document",
        `Document split into ${textChunks.length} chunks`
      )

      console.log(
        `[PROCESS] Step 4: Starting document structure analysis for document ${documentId}`
      )

      let sections: Section[]

      if (customTableOfContents) {
        console.log("[PROCESS] Using custom table of contents")
        sections = customTableOfContents
        await updateDocumentStatus(
          context.db,
          documentId,
          "analyzing_structure",
          `Using custom table of contents with ${sections.length} sections.`
        )
      } else {
        // Step 4: Analyze document structure
        await updateDocumentStatus(
          context.db,
          documentId,
          "analyzing_structure",
          "Analyzing document structure with AI... Sending chunks to Gemini for table of contents generation.",
          45
        )

        console.log(`[PROCESS] Starting structure analysis with Gemini API`)
        console.log(
          `[PROCESS] Processing ${textChunks.length} chunks with model: ${selectedModel}`
        )

        // Process each chunk and merge results
        let allSections: Section[] = []
        for (let i = 0; i < textChunks.length; i++) {
          await updateDocumentStatus(
            context.db,
            documentId,
            "analyzing_structure",
            `Analyzing chunk ${i + 1}/${textChunks.length}...`
          )

          const chunkSections = await analyzeDocumentStructure(
            textChunks[i],
            apiKey,
            selectedModel,
            context.db,
            documentId,
            i + 1, // chunk number
            textChunks.length // total chunks
          )

          console.log(
            `[PROCESS] Chunk ${i + 1} analysis complete. Found ${
              chunkSections.length
            } sections`
          )
          allSections = allSections.concat(chunkSections)
        }

        // Remove duplicate sections and merge overlapping ones
        sections = allSections
      }

      console.log(
        `[PROCESS] Structure analysis complete. Total sections found: ${sections.length}`
      )
      await updateDocumentStatus(
        context.db,
        documentId,
        "analyzing_structure",
        `Structure analysis complete. Total sections found: ${sections.length}`
      )
      console.log(
        `[PROCESS] Section titles:`,
        sections.map((s) => s.title)
      )

      await updateDocumentStatus(
        context.db,
        documentId,
        "analyzing_structure",
        `Document structure analysis completed. Identified ${sections.length} sections in the document.`,
        60
      )

      console.log(
        `[PROCESS] Step 5: Generating table of contents for document ${documentId}`
      )

      // Step 5: Generate Table of Contents EARLY
      await updateDocumentStatus(
        context.db,
        documentId,
        "generating_toc",
        "Generating table of contents... Saving section structure to database for immediate download.",
        65
      )

      console.log(`[PROCESS] Saving table of contents to database`)
      console.log(`[PROCESS] TOC data:`, JSON.stringify(sections, null, 2))

      // Save Table of Contents to database immediately
      await context.db
        .update(schema.documents)
        .set({
          tableOfContents: JSON.stringify(sections),
          tocGeneratedAt: new Date(),
          progress: 65,
          statusMessage: "Table of contents generated! Available for download.",
        })
        .where(eq(schema.documents.id, documentId))

      console.log(`[PROCESS] Table of contents saved successfully`)

      // STOP HERE FOR USER APPROVAL
      console.log(`[PROCESS] ⏸️ Pausing for user approval of outline`)

      // Prepare processing data for continuation (excluding large data and sensitive data like API key)
      const processingDataForContinuation = {
        documentId,
        selectedModel,
        fileName,
        // Note: API key, documentText and fileData excluded - client will provide these when continuing
      }

      console.log(
        `[PROCESS] About to update document with processing data. Document ID: ${documentId}`
      )
      console.log(
        `[PROCESS] Processing data contains: documentId, selectedModel (${selectedModel}), fileName (${fileName})`
      )

      try {
        await context.db
          .update(schema.documents)
          .set({
            status: "awaiting_outline_approval",
            currentStep: "awaiting_outline_approval",
            progress: 65,
            statusMessage:
              'Outline generated! Please review and click "Continue" to proceed with summarization.',
            processingData: JSON.stringify(processingDataForContinuation),
          })
          .where(eq(schema.documents.id, documentId))

        console.log(
          `[PROCESS] ✅ Document ${documentId} marked as awaiting outline approval`
        )
      } catch (dbError) {
        console.error(
          `[PROCESS] ❌ Database update failed for document ${documentId}:`,
          dbError
        )
        throw dbError
      }

      return Response.json({
        success: true,
        awaitingApproval: true,
        approvalType: "outline",
        hasTableOfContents: true,
        // Return minimal data - client should store large data locally if needed for continuation
        processingData: {
          documentId,
          selectedModel,
          fileName,
        },
      })
    } catch (processingError) {
      console.error(
        `[PROCESS] ❌ Processing error for document ${documentId}:`,
        processingError
      )
      console.error(
        `[PROCESS] Error stack:`,
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
        `[PROCESS] Document ${documentId} marked as failed in database`
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
    console.error("[PROCESS] ❌ API-level error:", error)
    console.error(
      "[PROCESS] Error details:",
      error instanceof Error ? error.stack : "No stack trace"
    )
    return Response.json({ error: "Internal server error" }, { status: 500 })
  }
}
