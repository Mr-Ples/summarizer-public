import * as schema from "~/database/schema"
import { eq } from "drizzle-orm"
import { Form, useNavigation, Link } from "react-router"
import { useState, useEffect, useMemo, useRef } from "react"
import { fetchAvailableModels, type AIModel } from "~/lib/ai-client"
import {
  generateSectionPDF,
  downloadPDF,
  stitchSectionPDFs,
} from "~/utils/pdfGenerator"

import type { Route } from "./+types/upload"
import { putS3Object } from "~/lib/s3.server"
import GithubImage from "@assets/github-mark-white.png"

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Upload PDF - PDF Summarizer" },
    { name: "description", content: "Upload and analyze PDFs with AI" },
  ]
}

type ProcessingStatus = {
  documentId: number
  status:
    | "processing"
    | "completed"
    | "failed"
    | "awaiting_outline_approval"
    | "awaiting_summary_approval"
  currentStep?: string
  progress?: number
  statusMessage?: string
  hasTableOfContents?: boolean
  errorMessage?: string
  outline?: any[]
  processingData?: any
  sections?: any[]
  pdfTitle?: string
  pdfAuthor?: string
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData()
  const action = formData.get("action")

  console.log(`[UPLOAD] New upload action: ${action}`)

  if (action === "uploadPdf") {
    // Get API key from form data
    const apiKey = formData.get("apiKey")
    console.log(
      `[UPLOAD] API key provided: ${!!apiKey} (length: ${
        (apiKey as string)?.length || 0
      })`
    )

    if (typeof apiKey !== "string" || !apiKey.trim()) {
      console.log("[UPLOAD] ❌ Missing API key")
      return { uploadError: "Please provide your Gemini API key" }
    }

    // Get selected model from form data
    const selectedModel = formData.get("selectedModel")
    console.log(`[UPLOAD] Selected model: ${selectedModel}`)

    if (typeof selectedModel !== "string" || !selectedModel.trim()) {
      console.log("[UPLOAD] ❌ Missing model selection")
      return { uploadError: "Please select a Gemini model" }
    }

    const pdfFile = formData.get("pdf") as File
    console.log(
      `[UPLOAD] File info: ${pdfFile?.name || "no file"} (${
        pdfFile?.size || 0
      } bytes, type: ${pdfFile?.type || "unknown"})`
    )

    if (!pdfFile || pdfFile.size === 0) {
      console.log("[UPLOAD] ❌ No file provided")
      return { uploadError: "Please select a PDF file" }
    }

    if (pdfFile.type !== "application/pdf") {
      console.log(`[UPLOAD] ❌ Invalid file type: ${pdfFile.type}`)
      return { uploadError: "Please upload a valid PDF file" }
    }

    // File size limit (10MB)
    if (pdfFile.size > 10 * 1024 * 1024) {
      console.log(
        `[UPLOAD] ❌ File too large: ${pdfFile.size} bytes (limit: 10MB)`
      )
      return { uploadError: "File size must be less than 10MB" }
    }

    // Get metadata from form data
    const pdfTitle = formData.get("pdfTitle") as string | null
    const pdfAuthor = formData.get("pdfAuthor") as string | null
    
    console.log(`[UPLOAD] PDF Title from form: ${pdfTitle}`)
    console.log(`[UPLOAD] PDF Author from form: ${pdfAuthor}`)

    try {
      console.log("[UPLOAD] Starting database record creation...")

      // Create document record with metadata
      const [document] = await context.db
        .insert(schema.documents)
        .values({
          originalName: pdfFile.name,
          fileSize: pdfFile.size,
          status: "processing",
          currentStep: "uploaded",
          progress: 0,
          statusMessage: "File uploaded, preparing for processing...",
          pdfTitle: pdfTitle || undefined,
          pdfAuthor: pdfAuthor || undefined,
        })
        .returning()

      console.log(`[UPLOAD] ✅ Document record created with ID: ${document.id}`)

      const b2Key = `pdfs/${document.id}/${pdfFile.name}`;
      // Convert file to base64 for processing
      const arrayBuffer = await pdfFile.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)

      try {
        await putS3Object(context.cloudflare.env, b2Key, uint8Array);
        // return new Response("Upload successful", { status: 200 });
      } catch (e) {
        console.error("[B2 UPLOAD ERROR]", e && (e instanceof Error ? e.stack : e));
        return new Response(`Failed to upload to B2: ${e instanceof Error ? e.message : e}` , { status: 500 });
      }
      // if (!uploadResponse.ok) {
      //   throw new Error("Failed to upload PDF to B2");
      // }
      // Store the B2 key in the database (handled by the API route)
      console.log(`[UPLOAD] ✅ PDF uploaded to B2 at key: ${b2Key}`);
      await context.db
        .update(schema.documents)
        .set({ pdfR2Key: b2Key })
        .where(eq(schema.documents.id, document.id));
      console.log(
        `[UPLOAD] Starting base64 conversion for ${pdfFile.size} bytes...`
      )


      console.log(
        `[UPLOAD] Converting to base64 using chunked approach (chunk size: 8192 bytes)...`
      )

      // Convert to base64 using a chunked approach to handle large files
      let binary = ""
      const chunkSize = 8192
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, i + chunkSize)
        binary += String.fromCharCode(...chunk)

        if (i % (chunkSize * 100) === 0) {
          // Log every 100 chunks
          console.log(
            `[UPLOAD] Base64 conversion progress: ${Math.round(
              (i / uint8Array.length) * 100
            )}%`
          )
        }
      }
      const base64Data = btoa(binary)

      console.log(
        `[UPLOAD] ✅ Base64 conversion complete. Result: ${base64Data.length} characters`
      )
      console.log(`[UPLOAD] Starting client-side PDF text extraction...`)

      // Update document status for client-side text extraction
      await context.db
        .update(schema.documents)
        .set({
          statusMessage:
            "File uploaded, starting client-side PDF text extraction...",
          progress: 5,
        })
        .where(eq(schema.documents.id, document.id))

      console.log(
        `[UPLOAD] ✅ Upload complete! Client will handle PDF processing`
      )

      // Handle custom table of contents if provided
      const customTocContent = formData.get("customToc") as string | null
      if (customTocContent && customTocContent.trim()) {
        console.log(
          `[UPLOAD] Custom TOC content provided: ${customTocContent.length} characters`
        )
      }

      return {
        success: true,
        message: `Upload successful! Starting PDF text extraction...`,
        documentId: document.id,
        fileData: base64Data,
        apiKey: apiKey.trim(),
        selectedModel: selectedModel.trim(),
        fileName: pdfFile.name,
        customTocContent: customTocContent?.trim() || null,
      }
    } catch (error) {
      console.error("[UPLOAD] ❌ Error uploading PDF:", error)
      console.error(
        "[UPLOAD] Error details:",
        error instanceof Error ? error.stack : "No stack trace"
      )
      return { uploadError: "Error uploading file. Please try again." }
    }
  }

  console.log(`[UPLOAD] ❌ Invalid action: ${action}`)
  return { error: "Invalid action" }
}

export default function Upload({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation()
  const [selectedModel, setSelectedModel] = useState("gemini-1.5-flash")
  const [apiKey, setApiKey] = useState("")
  const [processingStatus, setProcessingStatus] =
    useState<ProcessingStatus | null>(null)
  const [isExtractingText, setIsExtractingText] = useState(false)
  const [availableModels, setAvailableModels] = useState<AIModel[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [editableOutline, setEditableOutline] = useState<any[]>([])
  const [customTocText, setCustomTocText] = useState("")
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false)
  const [generatingSection, setGeneratingSection] = useState<string | null>(
    null
  )
  const [isGeneratingTTS, setIsGeneratingTTS] = useState(false)
  const [generatingTTSSection, setGeneratingTTSSection] = useState<string | null>(
    null
  )
  const [originalPDFData, setOriginalPDFData] = useState<string | null>(null)

  // Add download function to global scope
  useEffect(() => {
    globalThis.downloadAudio = (audioSrc: string, filename: string) => {
      const a = globalThis.document.createElement('a');
      a.href = audioSrc;
      a.download = filename;
      a.click();
    };
  }, []);

  useEffect(() => {
    console.log(processingStatus?.sections)
    const allCompleted = processingStatus?.sections?.every(
      (section: any) => section.status === "completed"
    )
    console.log(allCompleted)
  }, [processingStatus])

  const tocTemplate = `[
  {
    "title": "Section 1: Introduction",
    "start_page": 1,
    "end_page": 5
  },
  {
    "title": "Section 2: Deep Dive",
    "start_page": 6,
    "end_page": 15
  }
]`

  const handleTocFocus = () => {
    if (customTocText.trim() === "") {
      setCustomTocText(tocTemplate)
    }
  }

  // When processingStatus updates with an outline, initialize editableOutline
  useEffect(() => {
    if (processingStatus?.outline) {
      setEditableOutline(processingStatus.outline)
    }
  }, [processingStatus?.outline])

  // Handler to delete a section
  const handleDeleteSection = (index: number) => {
    setEditableOutline((prev) => prev.filter((_, i) => i !== index))
  }

  // Handler to update a section's page numbers
  const handleUpdateSection = (
    index: number,
    field: "start_page" | "end_page",
    value: number
  ) => {
    setEditableOutline((prev) =>
      prev.map((section, i) =>
        i === index ? { ...section, [field]: value } : section
      )
    )
  }

  // Load API key from localStorage on mount
  useEffect(() => {
    const savedApiKey = localStorage.getItem("gemini_api_key")
    if (savedApiKey) {
      setApiKey(savedApiKey)
    }

    const savedModel = localStorage.getItem("gemini_selected_model")
    if (savedModel) {
      setSelectedModel(savedModel)
    }
  }, [])

  // Save API key to localStorage when it changes
  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    if (value.trim()) {
      localStorage.setItem("gemini_api_key", value.trim())
    } else {
      localStorage.removeItem("gemini_api_key")
    }
  }

  // Save selected model to localStorage when it changes
  const handleModelChange = (value: string) => {
    setSelectedModel(value)
    if (value.trim()) {
      localStorage.setItem("gemini_selected_model", value.trim())
    } else {
      localStorage.removeItem("gemini_selected_model")
    }
  }

  // Fetch available models when API key changes
  useEffect(() => {
    if (apiKey.trim()) {
      console.log(
        "[UPLOAD] Fetching models with API key:",
        apiKey.substring(0, 10) + "..."
      )
      setLoadingModels(true)
      fetchAvailableModels(apiKey.trim())
        .then((models) => {
          // console.log('[UPLOAD] Received models:', models);
          setAvailableModels(models)
          // If current selected model is not in the list, select the first available model
          if (
            models.length > 0 &&
            !models.some((m) => m.name === selectedModel)
          ) {
            setSelectedModel(models[0].name)
          }
        })
        .catch((error) => {
          console.error("[UPLOAD] Failed to fetch models:", error)
          setAvailableModels([])
        })
        .finally(() => {
          setLoadingModels(false)
        })
    } else {
      setAvailableModels([])
    }
  }, [apiKey])

  // State to store processing data for continuation
  const [storedProcessingData, setStoredProcessingData] = useState<any>(null)

  // Client-side PDF text extraction using pdfjs-dist
  const extractPDFText = async (base64Data: string) => {
    console.log(`[CLIENT-PDF] Starting PDF text extraction...`)
    setIsExtractingText(true)

    try {
      // Load PDF.js from CDN to avoid server-side issues
      const pdfjsLib = await import(
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.3.93/build/pdf.min.mjs"
      )

      // Set worker from CDN
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.3.93/build/pdf.worker.min.mjs"

      console.log(
        `[CLIENT-PDF] PDF.js loaded, converting base64 to Uint8Array...`
      )

      // Convert base64 to Uint8Array
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      console.log(
        `[CLIENT-PDF] Loading PDF document (${bytes.length} bytes)...`
      )

      // Load PDF document
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
      console.log(
        `[CLIENT-PDF] PDF loaded successfully. Pages: ${pdf.numPages}`
      )

      let fullText = ""

      // Extract text from each page
      for (let i = 1; i <= pdf.numPages; i++) {
        console.log(
          `[CLIENT-PDF] Extracting text from page ${i}/${pdf.numPages}...`
        )

        const page = await pdf.getPage(i)
        const textContent = await page.getTextContent()

        // Concatenate text items with spaces
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ")

        fullText += `=== PAGE ${i} ===\n${pageText}\n\n`

        // Update progress
        const progress = 10 + Math.round((i / pdf.numPages) * 40) // 10-50% for text extraction
        console.log(`[CLIENT-PDF] Page ${i} complete. Progress: ${progress}%`)
      }

      console.log(
        `[CLIENT-PDF] ✅ Text extraction complete! Extracted ${Math.round(
          fullText.length / 1000
        )}k characters`
      )
      setIsExtractingText(false)

      return { fullText }
    } catch (error) {
      console.error("[CLIENT-PDF] ❌ Error extracting PDF text:", error)
      setIsExtractingText(false)
      throw error
    }
  }

  // Handle upload success and start client-side processing
  useEffect(() => {
    if (actionData?.success && actionData?.fileData) {
      const startProcessing = async () => {
        try {
          console.log(
            `[CLIENT-PDF] Starting client-side processing for document ${actionData.documentId}`
          )

          // Extract text from PDF on client side
          const { fullText: documentText } = await extractPDFText(actionData.fileData)

          // Send extracted text to server for AI processing
          console.log(`[CLIENT-PDF] Sending extracted text to server...`)

          let customTocJson: any = null
          if (actionData.customTocContent) {
            try {
              customTocJson = JSON.parse(actionData.customTocContent)
              console.log(
                `[CLIENT-PDF] Custom TOC parsed successfully. Sections: ${customTocJson.length}`
              )
            } catch (e) {
              console.error(`[CLIENT-PDF] Failed to parse custom TOC JSON:`, e)
            }
          }

          const processingData = {
            documentId: actionData.documentId,
            selectedModel: actionData.selectedModel,
            fileData: actionData.fileData,
            fileName: actionData.fileName,
            documentText: documentText,
            customTableOfContents: customTocJson,
          }

          // Pass API key as query parameter for security
          const processUrl = `/api/process?apiKey=${encodeURIComponent(
            actionData.apiKey
          )}`
          const response = await fetch(processUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(processingData),
          })

          if (response.ok) {
            console.log(
              `[CLIENT-PDF] ✅ Server processing started successfully`
            )

            // Store processing data for potential continuation after outline approval
            setStoredProcessingData({
              documentText: documentText,
              fileData: actionData.fileData,
              fileName: actionData.fileName,
              selectedModel: actionData.selectedModel,
              customTableOfContents: customTocJson,
            })

            // Store original PDF data for PDF generation
            setOriginalPDFData(actionData.fileData)

            // Start polling for status
            setProcessingStatus({
              documentId: actionData.documentId,
              status: "processing",
              progress: 50,
              statusMessage: "Text extracted! Starting AI analysis...",
            })
          } else {
            throw new Error("Failed to start server processing")
          }
        } catch (error) {
          console.error(
            "[CLIENT-PDF] ❌ Error in client-side processing:",
            error
          )
          setProcessingStatus({
            documentId: actionData.documentId,
            status: "failed",
            progress: 0,
            statusMessage: "Failed to extract PDF text",
            errorMessage:
              error instanceof Error ? error.message : "Unknown error",
          })
        }
      }

      startProcessing()
    }
  }, [actionData?.success, actionData?.fileData])

  // Poll for status if we have a processing document
  useEffect(() => {
    if (actionData?.documentId) {
      const documentId = actionData.documentId

      const pollStatus = async () => {
        try {
          const response = await fetch(`/api/status?documentId=${documentId}`)
          if (response.ok) {
            const data = await response.json()
            const newStatus = {
              documentId: data.document.id,
              status: data.document.status,
              currentStep: data.document.currentStep,
              progress: data.document.progress,
              statusMessage: data.document.statusMessage,
              hasTableOfContents: data.document.hasTableOfContents,
              errorMessage: data.document.errorMessage,
              outline: data.outline,
              processingData: data.processingData,
              sections: data.sections,
              pdfTitle: data.document.pdfTitle,
              pdfAuthor: data.document.pdfAuthor,
            }
            setProcessingStatus(newStatus)

            // Stop polling if completed, failed, or awaiting approval
            if (
              data.document.status === "completed" ||
              data.document.status === "failed" ||
              data.document.status === "awaiting_outline_approval" ||
              data.document.status === "awaiting_summary_approval"
            ) {
              return true // Stop polling
            }
          }
        } catch (error) {
          console.error("Error polling status:", error)
        }
        return false // Continue polling
      }

      // Start polling immediately
      pollStatus()

      // Continue polling every 2 seconds
      const interval = setInterval(async () => {
        const shouldStop = await pollStatus()
        if (shouldStop) {
          clearInterval(interval)
        }
      }, 2000)

      return () => clearInterval(interval)
    }
  }, [actionData?.documentId, actionData?.success])

  const getModelDisplayName = (model: string) => {
    switch (model) {
      case "gemini-1.5-pro":
        return "Most capable model"
      case "gemini-1.5-flash":
        return "Fast & efficient (recommended)"
      case "gemini-2.0-flash-exp":
        return "Experimental features"
      default:
        return model
    }
  }

  const downloadTableOfContents = async () => {
    if (editableOutline.length === 0) return

    const generateTocText = (toc: any[], documentName: string): string => {
      const lines = [
        `TABLE OF CONTENTS`,
        `Document: ${documentName}`,
        `Generated: ${new Date().toLocaleString()}`,
        ``,
        `─────────────────────────────────────────────────────`,
        ``,
      ]

      toc.forEach((section, index) => {
        const pageRange =
          section.start_page === section.end_page
            ? `Page ${section.start_page}`
            : `Pages ${section.start_page}-${section.end_page}`

        lines.push(`${index + 1}. ${section.title}`)
        lines.push(`   ${pageRange}`)
        lines.push(``)
      })

      lines.push(`─────────────────────────────────────────────────────`)
      lines.push(`End of Table of Contents`)

      return lines.join("\n")
    }

    const tocText = generateTocText(
      editableOutline,
      storedProcessingData?.fileName || actionData?.fileName || "document"
    )
    const blob = new Blob([tocText], { type: "text/plain" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `table_of_contents.txt`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  const downloadTableOfContentsJson = async () => {
    if (editableOutline.length === 0) return

    const tocData = {
      document:
        storedProcessingData?.fileName || actionData?.fileName || "document",
      generated: new Date().toISOString(),
      sections: editableOutline,
    }

    const tocJson = JSON.stringify(tocData, null, 2)
    const blob = new Blob([tocJson], { type: "application/json" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `table_of_contents.json`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  // Generate and download PDF for a single section
  const generateSectionPDFDownload = async (section: any) => {
    try {
      setIsGeneratingPDF(true)
      setGeneratingSection(section.title)

      console.log(`[UPLOAD] Generating PDF for section: ${section.title}`)

      // Use the original PDF data from the upload
      const pdfData = originalPDFData || actionData?.fileData
      if (!pdfData) {
        throw new Error("Original PDF data not available")
      }

      // Generate section PDF
      const pdfBytes = await generateSectionPDF(pdfData, {
        title: section.title,
        start_page: section.startPage,
        end_page: section.endPage,
        summary: section.summary,
      })

      // Download the generated PDF
      const filename = `${
        actionData?.fileName?.replace(".pdf", "") || "document"
      }_${section.title.replace(/[^a-zA-Z0-9]/g, "_")}_pages_${
        section.startPage
      }-${section.endPage}.pdf`
      downloadPDF(pdfBytes, filename)

      console.log(
        `[UPLOAD] ✅ Successfully generated and downloaded PDF for section: ${section.title}`
      )
    } catch (error) {
      console.error(
        `[UPLOAD] ❌ Error generating PDF for section ${section.title}:`,
        error
      )
      alert(
        `Failed to generate PDF for section "${section.title}": ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      )
    } finally {
      setIsGeneratingPDF(false)
      setGeneratingSection(null)
    }
  }

  // Generate TTS for a section
  const generateTTSForSection = async (section: any) => {
    setIsGeneratingTTS(true)
    setGeneratingTTSSection(section.title)

    try {
      // Generate TTS using puter.js (client-side only)
      if (typeof window !== 'undefined' && (window as any).puter) {
        console.log('Generating TTS for section:', section.title);
        (window as any).puter.ai.txt2speech("test");
        const audioElement = await (window as any).puter.ai.txt2speech(section.summary)
        console.log('Audio generated:', audioElement)

        // Create a temporary audio player for this section
        const audioContainer = globalThis.document.getElementById(`audio-container-${section.id || section.title.replace(/[^a-zA-Z0-9]/g, '_')}`)
        if (audioContainer) {
          audioContainer.innerHTML = `
            <audio controls class="w-full mb-2">
              <source src="${audioElement.src}" type="audio/mpeg" />
              Your browser does not support the audio element.
            </audio>
            <button
              onclick="downloadAudio('${audioElement.src}', '${section.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp3')"
              class="text-xs text-blue-500 hover:underline"
            >
              🎵 Download Audio
            </button>
          `
        }
        
      } else {
        throw new Error('Puter.js not loaded. Please ensure the script is included.')
      }
      
    } catch (err) {
      console.error('TTS Generation Error:', err)
      alert('Failed to generate TTS: ' + (err instanceof Error ? err.message : 'Unknown error'))
    } finally {
      setIsGeneratingTTS(false)
      setGeneratingTTSSection(null)
    }
  }

  const continueProcessing = async () => {
    if (!processingStatus?.processingData) {
      console.error("No processing data available for continuation")
      return
    }

    if (!apiKey.trim()) {
      console.error("API key not available for continuation")
      return
    }

    console.log("[UI] User approved outline, continuing with summarization...")

    // IMMEDIATE UI feedback when user clicks continue
    setProcessingStatus((prev) =>
      prev
        ? {
            ...prev,
            status: "processing",
            statusMessage:
              "Outline approved! Starting detailed summarization of sections...",
            progress: 70,
          }
        : null
    )
    // Update status to show server processing started
    setProcessingStatus((prev) =>
      prev
        ? {
            ...prev,
            status: "processing",
            statusMessage:
              "Server processing resumed! Generating detailed summaries for each section...",
            progress: 75,
          }
        : null
    )

    // Restart polling
    const pollStatus = async () => {
      try {
        const statusResponse = await fetch(
          `/api/status?documentId=${processingStatus.documentId}`
        )
        if (statusResponse.ok) {
          const data = await statusResponse.json()
          const newStatus = {
            documentId: data.document.id,
            status: data.document.status,
            currentStep: data.document.currentStep,
            progress: data.document.progress,
            statusMessage: data.document.statusMessage,
            hasTableOfContents: data.document.hasTableOfContents,
            errorMessage: data.document.errorMessage,
            outline: data.outline,
            processingData: data.processingData,
            sections: data.sections,
          }
          setProcessingStatus(newStatus)

          if (
            data.document.status === "completed" ||
            data.document.status === "failed"
          ) {
            return true
          }
        }
      } catch (error) {
        console.error("Error polling status:", error)
      }
      return false
    }

    // Start polling again
    const interval = setInterval(async () => {
      const shouldStop = await pollStatus()
      if (shouldStop) {
        clearInterval(interval)
      }
    }, 2000)
    try {
      // Pass API key as query parameter for security, and add required data to body
      const continueUrl = `/api/continue?apiKey=${encodeURIComponent(apiKey)}`
      const continueData = {
        ...processingStatus.processingData,
        // Need to re-include the large data that was excluded from database storage
        fileData: storedProcessingData?.fileData || actionData?.fileData,
        documentText: storedProcessingData?.documentText,
        updatedTableOfContents: editableOutline,
      }

      const response = await fetch(continueUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(continueData),
      })

      if (response.ok) {
        console.log("[UI] Continuation triggered successfully")
      } else {
        console.error("Failed to continue processing")
        setProcessingStatus((prev) =>
          prev
            ? {
                ...prev,
                status: "failed",
                statusMessage:
                  "Failed to continue processing. Please try again.",
                errorMessage: "Server request failed",
              }
            : null
        )
      }
    } catch (error) {
      console.error("Error continuing processing:", error)
      setProcessingStatus((prev) =>
        prev
          ? {
              ...prev,
              status: "failed",
              statusMessage: "Failed to continue processing. Please try again.",
              errorMessage:
                error instanceof Error ? error.message : "Unknown error",
            }
          : null
      )
    }
  }

  // Stitch all completed section PDFs and download as one PDF
  const stitchAllSectionsPDFDownload = async () => {
    try {
      if (!processingStatus?.sections || processingStatus.sections.length === 0)
        return
      const pdfData = originalPDFData || actionData?.fileData
      if (!pdfData) throw new Error("Original PDF data not available")
      // Only use completed sections
      // Generate PDFs for all completed sections
      const sectionPDFs: Uint8Array[] = []
      for (const section of processingStatus.sections) {
        // Map section fields to match generateSectionPDF signature
        const pdf = await generateSectionPDF(pdfData, {
          title: section.title,
          start_page: section.startPage,
          end_page: section.endPage,
          summary: section.summary,
        })
        sectionPDFs.push(pdf)
      }
      // Stitch all section PDFs into one
      const stitchedPdf = await stitchSectionPDFs(sectionPDFs)
      // Download the stitched PDF
      const filename = `${
        actionData?.fileName?.replace(".pdf", "") || "document"
      }_ALL_SECTIONS.pdf`
      downloadPDF(stitchedPdf, filename)
    } catch (error) {
      console.error("[UPLOAD] ❌ Error stitching all section PDFs:", error)
      alert(
        `Failed to generate full PDF: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      )
    }
  }

  const pdfUrl = useMemo(() => {
    const base64 = originalPDFData || actionData?.fileData
    console.log(base64)
    if (!base64) return null
    try {
      const byteCharacters = atob(base64)
      const byteNumbers = new Array(byteCharacters.length)
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
      }
      const byteArray = new Uint8Array(byteNumbers)
      const blob = new Blob([byteArray], { type: "application/pdf" })
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  }, [originalPDFData, actionData?.fileData])
  console.log(pdfUrl)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [localPdfUrl, setLocalPdfUrl] = useState<string | null>(null)

  const [fileMetadata, setFileMetadata] = useState<{title?: string, author?: string} | null>(null)
  const [isProcessingFile, setIsProcessingFile] = useState(false)

  // Function to extract first page text only
  const extractFirstPageText = async (base64Data: string) => {
    console.log(`[FIRST-PAGE] Starting first page text extraction...`)

    try {
      // Load PDF.js from CDN to avoid server-side issues
      const pdfjsLib = await import(
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.3.93/build/pdf.min.mjs"
      )

      // Set worker from CDN
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.3.93/build/pdf.worker.min.mjs"

      // Convert base64 to Uint8Array
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      // Load PDF document
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
      console.log(`[FIRST-PAGE] PDF loaded successfully. Pages: ${pdf.numPages}`)

      // Extract text from first page only
      const page = await pdf.getPage(1)
      const textContent = await page.getTextContent()

      // Concatenate text items with spaces
      const firstPageText = textContent.items
        .map((item: any) => item.str)
        .join(" ")

      console.log(`[FIRST-PAGE] ✅ First page text extracted: ${firstPageText.length} characters`)
      return firstPageText
    } catch (error) {
      console.error("[FIRST-PAGE] ❌ Error extracting first page text:", error)
      throw error
    }
  }

  // Function to extract metadata using AI
  const extractMetadataWithAI = async (firstPageText: string, apiKey: string) => {
    console.log(`[AI-METADATA] Starting AI metadata extraction...`)
    
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Analyze the following text from the first page of a document and extract the document title and author. 

Look for:
- Document title (usually at the top, in larger text, or clearly marked as the title)
- Author name (usually near the title, in author field, or in header/footer)
- If you can't find clear title/author, make your best guess based on context

Return ONLY a JSON object with this exact format:
{
  "title": "extracted or inferred title",
  "author": "extracted or inferred author name"
}

If you cannot determine title or author, use null for that field.

Document text:
${firstPageText.substring(0, 2000)}` // Limit to first 2000 chars to stay within token limits
            }]
          }]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[AI-METADATA] API Error Response:`, errorText)
        throw new Error(`AI API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text
      
      if (!aiResponse) {
        throw new Error('No response from AI')
      }

      console.log(`[AI-METADATA] AI response:`, aiResponse)

      // Clean the AI response to remove markdown formatting
      let cleanResponse = aiResponse.trim()
      
      // Remove markdown code blocks if present
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/^```json\n/, '').replace(/\n```$/, '')
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```\n/, '').replace(/\n```$/, '')
      }
      
      console.log(`[AI-METADATA] Cleaned response:`, cleanResponse)

      // Try to parse JSON from AI response
      try {
        const metadata = JSON.parse(cleanResponse)
        console.log(`[AI-METADATA] ✅ Parsed metadata:`, metadata)
        return {
          title: metadata.title || undefined,
          author: metadata.author || undefined
        }
      } catch (parseError) {
        console.error(`[AI-METADATA] ❌ Failed to parse AI response as JSON:`, parseError)
        console.error(`[AI-METADATA] Attempted to parse:`, cleanResponse)
        // Fallback: try to extract from text
        return {
          title: undefined,
          author: undefined
        }
      }
    } catch (error) {
      console.error(`[AI-METADATA] ❌ Error calling AI API:`, error)
      throw error
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    console.log("File selected:", file?.name)
    
    if (file && file.type === "application/pdf") {
      const url = URL.createObjectURL(file)
      setLocalPdfUrl(url)
      
      // Process PDF immediately to extract metadata and text
      setIsProcessingFile(true)
      try {
        console.log("[FILE-PREVIEW] Starting immediate PDF processing...")
        
        // Convert file to base64
        const arrayBuffer = await file.arrayBuffer()
        const uint8Array = new Uint8Array(arrayBuffer)
        let binary = ""
        const chunkSize = 8192
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.subarray(i, i + chunkSize)
          binary += String.fromCharCode(...chunk)
        }
        const base64Data = btoa(binary)
        
        // Extract first page text
        const firstPageText = await extractFirstPageText(base64Data)
        
        // Extract metadata using AI if API key is available
        let metadata = { title: undefined, author: undefined }
        if (apiKey.trim()) {
          try {
            metadata = await extractMetadataWithAI(firstPageText, apiKey.trim())
          } catch (aiError) {
            console.error("[FILE-PREVIEW] AI metadata extraction failed:", aiError)
            // Continue without AI metadata
          }
        }
        
        setFileMetadata(metadata)
        
        console.log("[FILE-PREVIEW] ✅ PDF processed successfully")
        console.log("[FILE-PREVIEW] Title:", metadata.title)
        console.log("[FILE-PREVIEW] Author:", metadata.author)
        console.log("[FILE-PREVIEW] First page text length:", firstPageText.length)
        
      } catch (error) {
        console.error("[FILE-PREVIEW] ❌ Error processing PDF:", error)
        setFileMetadata(null)
      } finally {
        setIsProcessingFile(false)
      }
    } else {
      setLocalPdfUrl(null)
      setFileMetadata(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            PDF Summarizer
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300 mb-4">
            AI-powered document analysis with Google Gemini
          </p>
          <div className="flex justify-center space-x-4">
            <a
              href="https://github.com/Mr-Ples/summarizer-public"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center bg-gray-800 hover:bg-gray-900 text-white font-medium py-2 px-4 rounded-md transition duration-200"
            >
              <img src={GithubImage} alt="GitHub" className="w-4 h-4 mr-2" />
              GitHub
            </a>
            <Link
              to="/gallery"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition duration-200"
            >
              View Public Gallery →
            </Link>
          </div>
        </header>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            Upload PDF
          </h2>

          <Form
            method="post"
            encType="multipart/form-data"
            className="space-y-4"
          >
            <input type="hidden" name="action" value="uploadPdf" />
            <input type="hidden" name="apiKey" value={apiKey} />
            <input type="hidden" name="selectedModel" value={selectedModel} />
            <input type="hidden" name="pdfTitle" value={fileMetadata?.title || ""} />
            <input type="hidden" name="pdfAuthor" value={fileMetadata?.author || ""} />

            {/* API Key Input */}
            <div>
              <label
                htmlFor="apiKey"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Gemini API Key
              </label>
              <input
                type="password"
                id="apiKey"
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder="Enter your Gemini API key"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                required
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Get your API key from{" "}
                <a
                  href="https://makersuite.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  Google AI Studio
                </a>
                . Stored locally in your browser.
              </p>
            </div>

            {/* Model Selection */}
            <div>
              <label
                htmlFor="selectedModel"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                AI Model
              </label>
              <select
                id="selectedModel"
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                required
                disabled={loadingModels || !apiKey.trim()}
              >
                {loadingModels ? (
                  <option value="">Loading models...</option>
                ) : availableModels.length > 0 ? (
                  <>
                    {/* Recommended Models Section */}
                    {(() => {
                      const recommendedModelNames = [
                        "models/gemini-2.5-pro",
                        "models/gemini-2.5-flash",
                        "models/gemini-2.5-flash-lite-preview-06-17",
                        "models/gemma-3-27b-it",
                      ]
                      const recommendedModels = availableModels.filter(
                        (model) => recommendedModelNames.includes(model.name)
                      )

                      if (recommendedModels.length > 0) {
                        const getModelLimits = (modelName: string) => {
                          switch (modelName) {
                            case "models/gemini-2.5-pro":
                              return " (100 requests /day)"
                            case "models/gemini-2.5-flash":
                              return " (250 requests /day)"
                            case "models/gemini-2.5-flash-lite-preview-06-17":
                              return " (1,000 requests /day)"
                            case "models/gemma-3-27b-it":
                              return " (14,400 requests /day)"
                            default:
                              return ""
                          }
                        }

                        return (
                          <optgroup label="⭐ Recommended Models">
                            {recommendedModels.map((model) => (
                              <option key={model.name} value={model.name}>
                                {model.displayName}
                                {getModelLimits(model.name)}
                              </option>
                            ))}
                          </optgroup>
                        )
                      }
                      return null
                    })()}

                    {/* Group remaining models by type */}
                    {["gemini", "gemma"].map((type) => {
                      const recommendedModelNames = [
                        "models/gemini-2.5-pro",
                        "models/gemini-2.5-flash",
                        "models/gemini-2.5-flash-lite-preview-06-17",
                        "models/gemma-3-27b-it",
                      ]
                      const modelsOfType = availableModels.filter(
                        (model) =>
                          model.type === type &&
                          !recommendedModelNames.includes(model.name)
                      )
                      if (modelsOfType.length === 0) return null

                      return (
                        <optgroup
                          key={type}
                          label={`${
                            type.charAt(0).toUpperCase() + type.slice(1)
                          } Models`}
                        >
                          {modelsOfType.map((model) => (
                            <option key={model.name} value={model.name}>
                              {model.displayName}
                            </option>
                          ))}
                        </optgroup>
                      )
                    })}
                  </>
                ) : apiKey.trim() ? (
                  <option value="">No models available</option>
                ) : (
                  <option value="">Enter API key to load models</option>
                )}
              </select>
              {availableModels.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {availableModels.find((m) => m.name === selectedModel)
                      ?.description || getModelDisplayName(selectedModel)}
                  </p>
                  {(() => {
                    const selectedModelInfo = availableModels.find(
                      (m) => m.name === selectedModel
                    )
                    if (selectedModelInfo) {
                      return (
                        <div className="flex flex-wrap gap-3 text-xs">
                          <span className="inline-flex items-center px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-md">
                            📥 Input:{" "}
                            {selectedModelInfo.inputTokenLimit?.toLocaleString() ||
                              "N/A"}{" "}
                            tokens
                          </span>
                          <span className="inline-flex items-center px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded-md">
                            📤 Output:{" "}
                            {selectedModelInfo.outputTokenLimit?.toLocaleString() ||
                              "N/A"}{" "}
                            tokens
                          </span>
                          <span className="inline-flex items-center px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 rounded-md">
                            🔧{" "}
                            {selectedModelInfo.type?.toUpperCase() || "Unknown"}{" "}
                            model
                          </span>
                        </div>
                      )
                    }
                    return null
                  })()}
                </div>
              )}
            </div>

            {/* File Input */}
            <div>
              <label
                htmlFor="pdf"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                PDF Document
              </label>
              <input
                type="file"
                id="pdf"
                name="pdf"
                accept=".pdf"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                required
                ref={fileInputRef}
                onChange={handleFileChange}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Maximum file size: 10MB
              </p>
            </div>

            {/* File Processing Status */}
            {isProcessingFile && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  <div>
                    <p className="text-blue-800 dark:text-blue-200 font-medium text-sm">
                      🤖 Analyzing PDF with AI...
                    </p>
                    <p className="text-blue-600 dark:text-blue-300 text-xs">
                      Extracting first page text and identifying title/author
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* File Metadata Display */}
            {fileMetadata && !isProcessingFile && (
              <div className="p-4 bg-green-50 dark:bg-green-900/50 border border-green-200 dark:border-green-800 rounded-lg">
                <h4 className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                  🤖 AI Analysis Complete
                </h4>
                <div className="space-y-1 text-sm">
                  {fileMetadata.title && (
                    <div className="flex items-center">
                      <span className="text-green-600 dark:text-green-300 font-medium w-16">Title:</span>
                      <span className="text-green-800 dark:text-green-200">{fileMetadata.title}</span>
                    </div>
                  )}
                  {fileMetadata.author && (
                    <div className="flex items-center">
                      <span className="text-green-600 dark:text-green-300 font-medium w-16">Author:</span>
                      <span className="text-green-800 dark:text-green-200">{fileMetadata.author}</span>
                    </div>
                  )}
                  {!fileMetadata.title && !fileMetadata.author && (
                    <p className="text-green-600 dark:text-green-300 text-xs">
                      AI could not identify title or author from first page
                    </p>
                  )}
                </div>
                <p className="text-green-600 dark:text-green-300 text-xs mt-2">
                  Analysis based on first page content using Gemma 3 27B
                </p>
              </div>
            )}

            {/* Editable Metadata Fields */}
            {!isProcessingFile && (
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="pdfTitle"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Document Title (Optional)
                  </label>
                  <input
                    type="text"
                    id="pdfTitle"
                    name="pdfTitle"
                    value={fileMetadata?.title || ""}
                    onChange={(e) => setFileMetadata(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="Enter document title or leave blank to use AI detection"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {fileMetadata?.title ? "✅ AI detected title shown above. Edit if needed." : "Leave blank to use AI detection"}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="pdfAuthor"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Document Author (Optional)
                  </label>
                  <input
                    type="text"
                    id="pdfAuthor"
                    name="pdfAuthor"
                    value={fileMetadata?.author || ""}
                    onChange={(e) => setFileMetadata(prev => ({ ...prev, author: e.target.value }))}
                    placeholder="Enter document author or leave blank to use AI detection"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {fileMetadata?.author ? "✅ AI detected author shown above. Edit if needed." : "Leave blank to use AI detection"}
                  </p>
                </div>
              </div>
            )}
            {/* REAL-TIME Processing Status Display */}
            {/* Embedded PDF Viewer */}
            {(localPdfUrl || pdfUrl) && (
              <div className="max-md:hidden mb-8">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                  Preview PDF
                </h3>
                <div className="w-full" style={{ height: "600px" }}>
                  <iframe
                    title="PDF Preview"
                    src={localPdfUrl || pdfUrl}
                    width="100%"
                    height="100%"
                    style={{ border: "1px solid #ccc", borderRadius: "8px" }}
                  />
                </div>
              </div>
            )}

            {/* Custom Table of Contents Input */}
            {!processingStatus &&<div>
              <label
                htmlFor="customToc"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Custom Table of Contents (Optional)
              </label>
              <textarea
                id="customToc"
                name="customToc"
                rows={8}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white font-mono text-sm"
                value={customTocText}
                onChange={(e) => setCustomTocText(e.target.value)}
                onFocus={handleTocFocus}
                placeholder={`[
                  {
                    "title": "Section 1: Introduction",
                    "start_page": 1,
                    "end_page": 5
                  },
                  {
                    "title": "Section 2: Deep Dive",
                    "start_page": 6,
                    "end_page": 15
                  }
                ]`}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Click the text area to populate with a template, then edit. Each
                object needs `title`, `start_page`, and `end_page`.
              </p>
            </div>}

            {!processingStatus && <button
              type="submit"
              disabled={navigation.state === "submitting" || !apiKey.trim() || isProcessingFile}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-2 px-4 rounded-md transition duration-200"
            >
              {navigation.state === "submitting"
                ? "Uploading..."
                : isProcessingFile
                ? "🤖 AI Analyzing PDF..."
                : "Upload & Analyze"}
            </button>}
          </Form>

          {/* Status Messages */}
          {actionData?.uploadError && (
            <div className="mt-4 p-3 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300 rounded">
              {actionData.uploadError}
            </div>
          )}

          {!processingStatus && actionData?.success && actionData?.message && (
            <div className="mt-4 p-3 bg-green-100 dark:bg-green-900 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 rounded">
              {actionData.message}
            </div>
          )}

          {/* Client-side text extraction indicator */}
          {isExtractingText && (
            <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-700 rounded-lg">
              <div className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                <div>
                  <p className="text-blue-800 dark:text-blue-200 font-medium text-sm">
                    🔍 Extracting text from PDF...
                  </p>
                  <p className="text-blue-600 dark:text-blue-300 text-xs">
                    Processing pages on your device for privacy and speed
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {processingStatus && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
              Processing Status - Document #{processingStatus.documentId}
            </h3>

            {/* PDF Metadata Display */}
            {(processingStatus.pdfTitle || processingStatus.pdfAuthor) && (
              <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
                <h4 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                  📄 PDF Information
                </h4>
                <div className="space-y-1 text-sm">
                  {processingStatus.pdfTitle && (
                    <div className="flex items-center">
                      <span className="text-blue-600 dark:text-blue-300 font-medium w-16">Title:</span>
                      <span className="text-blue-800 dark:text-blue-200">{processingStatus.pdfTitle}</span>
                    </div>
                  )}
                  {processingStatus.pdfAuthor && (
                    <div className="flex items-center">
                      <span className="text-blue-600 dark:text-blue-300 font-medium w-16">Author:</span>
                      <span className="text-blue-800 dark:text-blue-200">{processingStatus.pdfAuthor}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {processingStatus.status === "processing" && (
              <div className="space-y-4">
                {/* Progress Bar with Enhanced Info */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                      {processingStatus.progress || 0}% Complete
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      Step: {processingStatus.currentStep || "Starting..."}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 relative overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-400 dark:to-blue-500 h-4 rounded-full transition-all duration-1000 ease-out relative"
                      style={{ width: `${processingStatus.progress || 0}%` }}
                    >
                      <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
                    </div>
                  </div>

                  {/* Progress Milestones */}
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span
                      className={
                        processingStatus.progress >= 5
                          ? "text-blue-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 5 ? "✓" : "○"} Initialize
                    </span>
                    <span
                      className={
                        processingStatus.progress >= 25
                          ? "text-blue-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 25 ? "✓" : "○"} Extract Text
                    </span>
                    <span
                      className={
                        processingStatus.progress >= 45
                          ? "text-blue-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 45 ? "✓" : "○"} Analyze
                      Structure
                    </span>
                    <span
                      className={
                        processingStatus.progress >= 65
                          ? "text-blue-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 65 ? "✓" : "○"} Generate TOC
                    </span>
                    <span
                      className={
                        processingStatus.progress >= 75
                          ? "text-blue-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 75 ? "✓" : "○"} Create
                      Summaries
                    </span>
                    <span
                      className={
                        processingStatus.progress >= 100
                          ? "text-green-600 font-medium"
                          : ""
                      }
                    >
                      {processingStatus.progress >= 100 ? "✓" : "○"} Complete
                    </span>
                  </div>
                </div>

                {/* Current Status Message with Enhanced Styling */}
                {processingStatus.statusMessage && (
                  <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/50 dark:to-indigo-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0">
                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse mt-2"></div>
                      </div>
                      <div className="flex-grow">
                        <p className="text-blue-800 dark:text-blue-200 font-medium text-sm leading-relaxed">
                          {processingStatus.statusMessage}
                        </p>
                        <p className="text-blue-600 dark:text-blue-300 text-xs mt-1">
                          🤖 AI processing in progress... This may take a few
                          minutes depending on document size.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Table of Contents Available */}
                {processingStatus.hasTableOfContents && (
                  <div className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/50 dark:to-emerald-900/50 border border-green-200 dark:border-green-800 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="flex-shrink-0">
                          <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                        </div>
                        <div>
                          <p className="text-green-800 dark:text-green-200 font-medium">
                            📋 Table of contents ready!
                          </p>
                          <p className="text-green-600 dark:text-green-300 text-xs">
                            Document structure has been analyzed and is
                            available for download
                          </p>
                        </div>
                      </div>
                      <div className="flex space-x-2">
                        <button
                          onClick={downloadTableOfContents}
                          className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition duration-200 font-medium shadow-sm"
                        >
                          📥 Download TXT
                        </button>
                        <button
                          onClick={downloadTableOfContentsJson}
                          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition duration-200 font-medium shadow-sm"
                        >
                          📥 Download JSON
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {(processingStatus.status === "completed" ||
              (processingStatus.status === "processing" &&
                processingStatus.sections &&
                processingStatus.sections.length > 0)) && (
              <div className="space-y-4 mt-unit-2">
                {processingStatus.status === "completed" && (
                  <div className="p-6 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/50 dark:to-emerald-900/50 border border-green-200 dark:border-green-800 rounded-lg">
                    <div className="text-center space-y-3">
                      <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 dark:bg-green-800 rounded-full">
                        <svg
                          className="w-6 h-6 text-green-600 dark:text-green-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      </div>
                      <div>
                        <p className="text-green-800 dark:text-green-200 font-bold text-lg">
                          🎉 Processing Complete!
                        </p>
                        <p className="text-green-600 dark:text-green-300 text-sm mt-1">
                          {processingStatus.statusMessage ||
                            "Your PDF has been successfully analyzed and summarized."}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {processingStatus.status === "processing" &&
                  processingStatus.sections &&
                  processingStatus.sections.length > 0 && (
                    <div className="p-6 mt-2 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/50 dark:to-indigo-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
                      <div className="text-center space-y-3">
                        <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 dark:bg-blue-800 rounded-full">
                          <svg
                            className="w-6 h-6 text-blue-600 dark:text-blue-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M13 10V3L4 14h7v7l9-11h-7z"
                            />
                          </svg>
                        </div>
                        <div>
                          <p className="text-blue-800 dark:text-blue-200 font-bold text-lg">
                            ⚡ Sections Ready for Download!
                          </p>
                          <p className="text-blue-600 dark:text-blue-300 text-sm mt-1">
                            {processingStatus.statusMessage ||
                              "Some sections are ready while others are still being processed."}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                {/* Completed Sections with PDF Downloads */}
                {processingStatus.sections &&
                  processingStatus.sections.length > 0 && (
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                        <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                          📄 Available Sections (
                          {processingStatus.sections.length})
                          {processingStatus.status === "processing" && (
                            <span className="ml-2 text-sm font-normal text-blue-600 dark:text-blue-400">
                              • More sections processing...
                            </span>
                          )}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          Download individual section PDFs with summaries
                        </p>
                      </div>
                      <div className="p-6">
                        <div className="space-y-4 max-h-96 overflow-y-auto">
                          {processingStatus.sections.map(
                            (section: any, index: number) => (
                              <div
                                key={index}
                                className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                              >
                                <div className="flex-grow">
                                  <div className="flex items-center space-x-2">
                                    <h5 className="font-medium text-gray-900 dark:text-white text-sm">
                                      {section.title}
                                    </h5>
                                    <div className="flex items-center space-x-1">
                                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                      <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                                        Ready
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex items-center space-x-4 mt-2">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                      📄 Pages {section.startPage}-
                                      {section.endPage}
                                    </span>
                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                      📝{" "}
                                      {section.summary?.split("\n").length || 0}{" "}
                                      bullet points
                                    </span>
                                  </div>
                                </div>
                                <div className="flex-shrink-0 flex gap-2">
                                  <button
                                    onClick={() =>
                                      generateSectionPDFDownload(section)
                                    }
                                    disabled={isGeneratingPDF}
                                    className={`inline-flex items-center text-xs px-3 py-2 rounded transition duration-200 ${
                                      isGeneratingPDF &&
                                      generatingSection === section.title
                                        ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                        : "bg-blue-500 text-white hover:bg-blue-600"
                                    }`}
                                  >
                                    {isGeneratingPDF &&
                                    generatingSection === section.title ? (
                                      <>
                                        <span className="animate-spin mr-1">
                                          ⏳
                                        </span>
                                        Generating...
                                      </>
                                    ) : (
                                      <>📄 Download PDF</>
                                    )}
                                  </button>
                                  
                                  <button
                                    onClick={() => generateTTSForSection(section)}
                                    disabled={isGeneratingTTS}
                                    className={`inline-flex items-center text-xs px-3 py-2 rounded transition duration-200 ${
                                      isGeneratingTTS && generatingTTSSection === section.title
                                        ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                        : "bg-green-500 text-white hover:bg-green-600"
                                    }`}
                                  >
                                    {isGeneratingTTS && generatingTTSSection === section.title ? (
                                      <>
                                        <span className="animate-spin mr-1">🎵</span>
                                        Generating TTS...
                                      </>
                                    ) : (
                                      <>🎵 Generate TTS</>
                                    )}
                                  </button>
                                </div>
                                
                                {/* Client-side TTS audio container */}
                                <div id={`audio-container-${section.id || section.title.replace(/[^a-zA-Z0-9]/g, '_')}`} className="mt-2"></div>

                              </div>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                {processingStatus.status === "completed" && (
                  <div className="text-center space-y-3">
                    <Link
                      to="/gallery"
                      className="inline-block bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-medium py-3 px-8 rounded-lg transition duration-200 shadow-lg transform hover:scale-105"
                    >
                      🔍 View Results in Gallery →
                    </Link>
                    <p className="text-gray-500 dark:text-gray-400 text-xs">
                      Your document summaries and downloadable PDFs are now
                      available
                    </p>
                  </div>
                )}

                {processingStatus.sections &&
                  processingStatus.sections.length > 0 && (
                    <div className="flex justify-end mb-4">
                      <button
                        onClick={stitchAllSectionsPDFDownload}
                        className="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 transition duration-200 font-medium shadow-sm"
                      >
                        📄 Download Full PDF (All Sections)
                      </button>
                    </div>
                  )}
              </div>
            )}

            {processingStatus.status === "awaiting_outline_approval" && (
              <div className="space-y-6">
                <div className="p-6 bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-900/50 dark:to-amber-900/50 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <div className="flex items-center space-x-4 mb-4">
                    <div className="flex-shrink-0">
                      <div className="inline-flex items-center justify-center w-12 h-12 bg-yellow-100 dark:bg-yellow-800 rounded-full">
                        <svg
                          className="w-6 h-6 text-yellow-600 dark:text-yellow-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-yellow-800 dark:text-yellow-200">
                        📋 Outline Generated - Review Required
                      </h3>
                      <p className="text-yellow-600 dark:text-yellow-300 text-sm">
                        AI has analyzed your document structure. Please review
                        the outline below and click "Continue" to proceed with
                        summarization.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Outline Display */}
                {editableOutline.length > 0 && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                      <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                        📖 Document Outline ({editableOutline.length} sections)
                      </h4>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                        Review and edit this structure before proceeding to
                        detailed summarization
                      </p>
                    </div>
                    <div className="p-6">
                      <div className="space-y-4 max-h-96 overflow-y-auto">
                        {editableOutline.map((section, index) => (
                          <div
                            key={index}
                            className="flex items-center space-x-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                          >
                            <div className="flex-shrink-0">
                              <div className="w-8 h-8 bg-blue-100 dark:bg-blue-800 rounded-full flex items-center justify-center">
                                <span className="text-blue-600 dark:text-blue-400 text-sm font-semibold">
                                  {index + 1}
                                </span>
                              </div>
                            </div>
                            <div className="flex-grow min-w-0">
                              <h5 className="font-medium text-gray-900 dark:text-white text-sm">
                                {section.title}
                              </h5>
                              <div className="flex items-center space-x-4 mt-2">
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  📄 Pages
                                </span>
                                <input
                                  type="number"
                                  value={section.start_page}
                                  onChange={(e) =>
                                    handleUpdateSection(
                                      index,
                                      "start_page",
                                      parseInt(e.target.value)
                                    )
                                  }
                                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white text-sm"
                                />
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  -
                                </span>
                                <input
                                  type="number"
                                  value={section.end_page}
                                  onChange={(e) =>
                                    handleUpdateSection(
                                      index,
                                      "end_page",
                                      parseInt(e.target.value)
                                    )
                                  }
                                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white text-sm"
                                />
                              </div>
                            </div>
                            <div className="flex-shrink-0">
                              <button
                                onClick={() => handleDeleteSection(index)}
                                className="p-2 bg-red-500 text-white rounded-full hover:bg-red-600 transition duration-200"
                                aria-label="Delete section"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 rounded-b-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-4">
                          <button
                            onClick={downloadTableOfContents}
                            className="px-4 py-2 bg-gray-600 text-white text-sm rounded-md hover:bg-gray-700 transition duration-200 font-medium"
                          >
                            📥 Download TXT
                          </button>
                          <button
                            onClick={downloadTableOfContentsJson}
                            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition duration-200 font-medium"
                          >
                            📥 Download JSON
                          </button>
                        </div>
                        <div className="flex items-center space-x-3">
                          <button
                            onClick={continueProcessing}
                            className="px-6 py-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white text-sm rounded-md transition duration-200 font-medium shadow-lg transform hover:scale-105"
                          >
                            ✅ Continue
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {processingStatus.status === "failed" && (
              <div className="p-6 bg-gradient-to-r from-red-50 to-pink-50 dark:from-red-900/50 dark:to-pink-900/50 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-start space-x-4">
                  <div className="flex-shrink-0">
                    <div className="inline-flex items-center justify-center w-10 h-10 bg-red-100 dark:bg-red-800 rounded-full">
                      <svg
                        className="w-5 h-5 text-red-600 dark:text-red-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </div>
                  </div>
                  <div className="flex-grow">
                    <p className="text-red-800 dark:text-red-200 font-bold text-lg">
                      ⚠️ Processing Failed
                    </p>
                    <p className="text-red-600 dark:text-red-300 text-sm mt-1">
                      Something went wrong while processing your document.
                      Please try again.
                    </p>
                    {processingStatus.errorMessage && (
                      <div className="mt-3 p-3 bg-red-100 dark:bg-red-800/50 rounded border border-red-200 dark:border-red-700">
                        <p className="text-red-800 dark:text-red-200 text-sm font-mono">
                          <strong>Error details:</strong>{" "}
                          {processingStatus.errorMessage}
                        </p>
                      </div>
                    )}
                    <div className="mt-4">
                      <button
                        onClick={() => window.location.reload()}
                        className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 transition duration-200 font-medium"
                      >
                        🔄 Try Again
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
