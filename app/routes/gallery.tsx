import * as schema from "~/database/schema"
import { eq, desc, asc } from "drizzle-orm"
import { Link } from "react-router"
import { useState, useEffect, useMemo } from "react"

import type { Route } from "./+types/gallery"
import {
  generateSectionPDF,
  stitchSectionPDFs,
  downloadPDF,
} from "../utils/pdfGenerator"
import GithubImage from "@assets/github-mark-white.png"

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Public Gallery - PDF Summarizer" },
    { name: "description", content: "Browse publicly processed PDF summaries" },
  ]
}

type Document = {
  id: number
  originalName: string
  status: "completed"
  hasTableOfContents?: boolean
  tocGeneratedAt?: Date
  summary?: string
  createdAt: Date
  completedAt?: Date
  pdfR2Key?: string
  pdfTitle?: string
  pdfAuthor?: string
}

type Section = {
  id: number
  title: string
  summary: string
  startPage: number
  endPage: number
  sectionNumber: number
  pdfPath?: string
}

export async function loader({ context }: Route.LoaderArgs) {
  // Get ONLY completed documents with their sections
  const documents = await context.db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.status, "completed"))
    .orderBy(desc(schema.documents.createdAt))

  // Get sections for all completed documents
  const sections: { [documentId: number]: Section[] } = {}
  for (const doc of documents) {
    const docSections = await context.db
      .select()
      .from(schema.sections)
      .where(eq(schema.sections.documentId, doc.id))
      .orderBy(asc(schema.sections.sectionNumber))
    sections[doc.id] = docSections
  }

  return {
    documents: documents.map((doc) => ({
      ...doc,
      summary: doc.summary || undefined,
      hasTableOfContents: !!doc.tableOfContents,
      tocGeneratedAt: doc.tocGeneratedAt
        ? new Date(doc.tocGeneratedAt)
        : undefined,
      createdAt: new Date(doc.createdAt),
      completedAt: doc.completedAt ? new Date(doc.completedAt) : undefined,
    })),
    sections,
  }
}

function DocumentCard({
  document,
  sections,
  searchQuery,
}: {
  document: Document
  sections: Section[]
  searchQuery: string
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatingSection, setGeneratingSection] = useState<string | null>(
    null
  )
  const [isGeneratingTTS, setIsGeneratingTTS] = useState(false)
  const [generatingTTSSection, setGeneratingTTSSection] = useState<string | null>(
    null
  )

  // Highlight matching text function
  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-800 px-1 rounded">$1</mark>');
  };

  const downloadTableOfContents = async () => {
    try {
      const response = await fetch(
        `/api/status?documentId=${document.id}&action=download-toc`
      )
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = globalThis.document.createElement("a")
        a.href = url
        a.download = `${document.originalName.replace(
          ".pdf",
          ""
        )}_table_of_contents.txt`
        globalThis.document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        globalThis.document.body.removeChild(a)
      }
    } catch (error) {
      console.error("Error downloading table of contents:", error)
    }
  }

  const downloadTableOfContentsJson = async () => {
    try {
      const response = await fetch(
        `/api/status?documentId=${document.id}&action=download-toc-json`
      )
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = globalThis.document.createElement("a")
        a.href = url
        a.download = `${document.originalName.replace(
          ".pdf",
          ""
        )}_table_of_contents.json`
        globalThis.document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        globalThis.document.body.removeChild(a)
      }
    } catch (error) {
      console.error("Error downloading table of contents JSON:", error)
    }
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  // Fetch original PDF as base64 from R2
  const fetchOriginalPDFBase64 = async () => {
    if (!document.pdfR2Key) throw new Error("No R2 key")
    const response = await fetch(
      `/api/files/original?key=${encodeURIComponent(document.pdfR2Key)}`
    )
    if (!response.ok) throw new Error("Failed to fetch original PDF")
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(",")[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  // Generate and download full summary PDF (stitched)
  const handleDownloadFullPDF = async () => {
    try {
      setIsGenerating(true)
      const base64Data = await fetchOriginalPDFBase64()
      const sectionPDFs: Uint8Array[] = []
      for (const section of sections) {
        const pdf = await generateSectionPDF(base64Data, {
          title: section.title,
          start_page: section.startPage,
          end_page: section.endPage,
          summary: section.summary,
        })
        sectionPDFs.push(pdf)
      }
      const stitchedPdf = await stitchSectionPDFs(sectionPDFs)
      const filename = `${document.originalName.replace(
        ".pdf",
        ""
      )}_ALL_SECTIONS.pdf`
      downloadPDF(stitchedPdf, filename)
    } catch (e) {
      alert(
        "Failed to generate full PDF: " + (e instanceof Error ? e.message : e)
      )
    } finally {
      setIsGenerating(false)
    }
  }

  // Generate and download a single section PDF
  const handleDownloadSectionPDF = async (section: Section) => {
    try {
      setIsGenerating(true)
      setGeneratingSection(section.title)
      const base64Data = await fetchOriginalPDFBase64()
      const pdf = await generateSectionPDF(base64Data, {
        title: section.title,
        start_page: section.startPage,
        end_page: section.endPage,
        summary: section.summary,
      })
      const filename = `${document.originalName.replace(
        ".pdf",
        ""
      )}_${section.title.replace(/[^a-zA-Z0-9]/g, "_")}_pages_${
        section.startPage
      }-${section.endPage}.pdf`
      downloadPDF(pdf, filename)
    } catch (e) {
      alert(
        "Failed to generate section PDF: " +
          (e instanceof Error ? e.message : e)
      )
    } finally {
      setIsGenerating(false)
      setGeneratingSection(null)
    }
  }

  const generateTTSForSection = async (section: Section) => {
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
        const audioContainer = globalThis.document.getElementById(`audio-container-${section.id}`)
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

  const generateTTSForFullSummary = async () => {
    setIsGeneratingTTS(true)
    setGeneratingTTSSection('full-summary')

    try {
      // Combine all section summaries into one text
      const fullSummary = sections.map(section => 
        `${section.title}:\n${section.summary}`
      ).join('\n\n')

      // Generate TTS using puter.js (client-side only)
      if (typeof window !== 'undefined' && (window as any).puter) {
        console.log('Generating TTS for full summary');
        (window as any).puter.ai.txt2speech("test");
        const audioElement = await (window as any).puter.ai.txt2speech(fullSummary)
        console.log('Full summary audio generated:', audioElement)

        // Create a temporary audio player for the full summary
        const audioContainer = globalThis.document.getElementById(`full-summary-audio-container`)
        if (audioContainer) {
          audioContainer.innerHTML = `
            <audio controls class="w-full mb-2">
              <source src="${audioElement.src}" type="audio/mpeg" />
              Your browser does not support the audio element.
            </audio>
            <button
              onclick="downloadAudio('${audioElement.src}', '${document.originalName.replace(/[^a-zA-Z0-9]/g, '_')}_FULL_SUMMARY.mp3')"
              class="text-xs text-blue-500 hover:underline"
            >
              🎵 Download Full Summary Audio
            </button>
          `
        }
        
      } else {
        throw new Error('Puter.js not loaded. Please ensure the script is included.')
      }
      
    } catch (err) {
      console.error('Full Summary TTS Generation Error:', err)
      alert('Failed to generate full summary TTS: ' + (err instanceof Error ? err.message : 'Unknown error'))
    } finally {
      setIsGeneratingTTS(false)
      setGeneratingTTSSection(null)
    }
  }

  const downloadFullSummaryText = () => {
    const fullSummary = sections.map(section => 
      `${section.title}:\n${section.summary}`
    ).join('\n\n')
    
    const blob = new Blob([fullSummary], { type: 'text/plain' })
    const url = window.URL.createObjectURL(blob)
    const a = globalThis.document.createElement("a")
    a.href = url
    a.download = `${document.originalName.replace(".pdf", "")}_FULL_SUMMARY.txt`
    globalThis.document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    globalThis.document.body.removeChild(a)
  }

  const downloadSectionSummaryText = (section: Section) => {
    const blob = new Blob([section.summary], { type: 'text/plain' })
    const url = window.URL.createObjectURL(blob)
    const a = globalThis.document.createElement("a")
    a.href = url
    a.download = `${document.originalName.replace(".pdf", "")}_${section.title.replace(/[^a-zA-Z0-9]/g, "_")}_pages_${section.startPage}-${section.endPage}.txt`
    globalThis.document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    globalThis.document.body.removeChild(a)
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            <span>{document.originalName}</span>
          </h3>
          
          {/* PDF Metadata Display */}
          {(document.pdfTitle || document.pdfAuthor) && (
            <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="space-y-1 text-sm">
                {document.pdfTitle && (
                  <div className="flex items-center">
                    <span className="text-blue-600 dark:text-blue-300 font-medium w-16">Title:</span>
                    <span 
                      className="text-blue-800 dark:text-blue-200"
                      dangerouslySetInnerHTML={{ 
                        __html: highlightText(document.pdfTitle, searchQuery) 
                      }}
                    />
                  </div>
                )}
                {document.pdfAuthor && (
                  <div className="flex items-center">
                    <span className="text-blue-600 dark:text-blue-300 font-medium w-16">Author:</span>
                    <span 
                      className="text-blue-800 dark:text-blue-200"
                      dangerouslySetInnerHTML={{ 
                        __html: highlightText(document.pdfAuthor, searchQuery) 
                      }}
                    />
                  </div>
                )}                
              </div>
            </div>
          )}
          {document.pdfR2Key && (
            <div className="mb-2">
              <a
                href={`/api/files/original?key=${encodeURIComponent(
                  document.pdfR2Key
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs text-blue-600 hover:underline"
              >
                📥 Download Original PDF
              </a>
              {document.hasTableOfContents && (
                <>
                  <a
                    onClick={downloadTableOfContents}
                    className="inline-flex items-center text-xs text-blue-600 hover:underline ml-4 cursor-pointer"
                  >
                    📥 TOC TXT
                  </a>
                  <a
                    onClick={downloadTableOfContentsJson}
                    className="inline-flex items-center text-xs text-blue-600 hover:underline ml-4 cursor-pointer"
                  >
                    📥 TOC JSON
                  </a>
                </>
              )}
            </div>
          )}
          <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>📅 {formatDate(document.createdAt)}</span>
            {document.completedAt && (
              <span>✅ Completed {formatDate(document.completedAt)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 text-xs rounded-full">
            Completed
          </span>
        </div>
      </div>

      {/* Document Sections */}
      {sections.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {sections.length} sections analyzed
            </p>
          </div>

          <div className="flex justify-end mb-4 gap-2">
            <button
              onClick={handleDownloadFullPDF}
              disabled={isGenerating}
              className="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 transition duration-200 font-medium shadow-sm"
            >
              {isGenerating
                ? "Generating..."
                : "📄 Download Full Summary PDF (All Sections)"}
            </button>
            
            <button
              onClick={downloadFullSummaryText}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition duration-200 font-medium shadow-sm"
            >
              📝 Download Full Summary Text
            </button>
            
            <button
              onClick={generateTTSForFullSummary}
              disabled={isGeneratingTTS}
              className={`px-4 py-2 text-sm rounded-md transition duration-200 font-medium shadow-sm ${
                isGeneratingTTS && generatingTTSSection === 'full-summary'
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-green-600 text-white hover:bg-green-700"
              }`}
            >
              {isGeneratingTTS && generatingTTSSection === 'full-summary' ? (
                <>
                  <span className="animate-spin mr-1">🎵</span>
                  Generating TTS...
                </>
              ) : (
                "🎵 Generate Full Summary TTS"
              )}
            </button>
          </div>
          
          {/* Full summary TTS audio container */}
          <div id="full-summary-audio-container" className="mb-4"></div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full px-4 py-3 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition duration-200 font-medium flex items-center justify-center gap-2"
          >
            {isExpanded ? (
              <>
                Hide sections
                <svg className="w-4 h-4 transform rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </>
            ) : (
              <>
                See all sections
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </>
            )}
          </button>
          
          {/* Full summary TTS audio container */}
          <div id="full-summary-audio-container" className="mb-4"></div>

          {isExpanded && (
            <>
              <div className="space-y-4 mt-4 border-t dark:border-gray-700 pt-4">
                {sections.map((section) => (
                  <div
                    key={section.id}
                    className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="font-medium text-gray-900 dark:text-white">
                        <span dangerouslySetInnerHTML={{ 
                          __html: highlightText(section.title, searchQuery) 
                        }} />
                      </h4>
                      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-2">
                        Pages {section.startPage}-{section.endPage}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                      {section.summary.split("\n").map((line, index) => {
                        if (
                          line.trim().startsWith("•") ||
                          line.trim().startsWith("-")
                        ) {
                          return (
                            <div key={index} className="flex items-start">
                              <span className="text-blue-500 mr-2 mt-1">•</span>
                              <span dangerouslySetInnerHTML={{ 
                                __html: highlightText(line.replace(/^[•\-]\s*/, ""), searchQuery) 
                              }} />
                            </div>
                          )
                        }
                        return line.trim() ? (
                          <p key={index} dangerouslySetInnerHTML={{ 
                            __html: highlightText(line, searchQuery) 
                          }} />
                        ) : null
                      })}
                    </div>
                    {section.pdfPath && (
                      <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-600">
                        <a
                          href={section.pdfPath}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-xs text-blue-500 hover:text-blue-600"
                        >
                          📄 View Section PDF
                        </a>
                      </div>
                    )}
                    {/* Client-side TTS audio container */}
                    <div id={`audio-container-${section.id}`} className="mt-2"></div>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => handleDownloadSectionPDF(section)}
                        disabled={
                          isGenerating && generatingSection === section.title
                        }
                        className={`inline-flex items-center text-xs px-3 py-2 rounded transition duration-200 ${
                          isGenerating && generatingSection === section.title
                            ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                            : "bg-blue-500 text-white hover:bg-blue-600"
                        }`}
                      >
                        {isGenerating && generatingSection === section.title ? (
                          <>
                            <span className="animate-spin mr-1">⏳</span>
                            Generating...
                          </>
                        ) : (
                          <>📄 Download Section PDF</>
                        )}
                      </button>
                      
                      <button
                        onClick={() => downloadSectionSummaryText(section)}
                        className="inline-flex items-center text-xs px-3 py-2 rounded transition duration-200 bg-orange-500 text-white hover:bg-orange-600"
                      >
                        📝 Download Section Text
                      </button>
                      
                      <button
                        onClick={() => generateTTSForSection(section)}
                        disabled={
                          isGeneratingTTS && generatingTTSSection === section.title
                        }
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
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function Gallery({ loaderData }: Route.ComponentProps) {
  const { documents, sections } = loaderData
  const [searchQuery, setSearchQuery] = useState("")

  // Add download function to global scope
  useEffect(() => {
    (window as any).downloadAudio = (audioSrc: string, filename: string) => {
      const a = document.createElement('a');
      a.href = audioSrc;
      a.download = filename;
      a.click();
    };
  }, []);

  // Fuzzy search function
  const fuzzySearch = (text: string, query: string): boolean => {
    if (!query.trim()) return true;
    
    const normalizedText = text.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    
    // Check for exact substring match first (most common case)
    if (normalizedText.includes(normalizedQuery)) return true;
    
    // For fuzzy matching, require at least 3 characters and check if query characters appear in order
    if (normalizedQuery.length >= 3) {
      let queryIndex = 0;
      let lastMatchIndex = -1;
      
      for (let i = 0; i < normalizedText.length && queryIndex < normalizedQuery.length; i++) {
        if (normalizedText[i] === normalizedQuery[queryIndex]) {
          // Ensure characters are not too far apart (within reasonable distance)
          if (lastMatchIndex === -1 || i - lastMatchIndex <= 10) {
            lastMatchIndex = i;
            queryIndex++;
          }
        }
      }
      
      return queryIndex === normalizedQuery.length;
    }
    
    // For short queries (1-2 characters), require exact substring match
    return false;
  };

  // Filter documents based on search query
  const filteredDocuments = useMemo(() => {
    if (!searchQuery.trim()) return documents;
    
    return documents.filter(doc => {
      // Search in document name
      if (fuzzySearch(doc.originalName, searchQuery)) return true;
      
      // Search in PDF title and author
      if (doc.pdfTitle && fuzzySearch(doc.pdfTitle, searchQuery)) return true;
      if (doc.pdfAuthor && fuzzySearch(doc.pdfAuthor, searchQuery)) return true;
      
      // Search in document summary
      if (doc.summary && fuzzySearch(doc.summary, searchQuery)) return true;
      
      // Search in section titles and summaries
      const docSections = sections[doc.id] || [];
      return docSections.some(section => 
        fuzzySearch(section.title, searchQuery) || 
        fuzzySearch(section.summary, searchQuery)
      );
    });
  }, [documents, sections, searchQuery]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Public Gallery
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300 mb-4">
            Browse completed PDF summaries
          </p>
          <div className="flex justify-center space-x-4">
            <Link
              to="/"
              className="inline-block bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-md transition duration-200"
            >
              ← Upload New PDF
            </Link>
            <a
              href="https://github.com/Mr-Ples/summarizer-public"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center bg-gray-800 hover:bg-gray-900 text-white font-medium py-2 px-4 rounded-md transition duration-200"
            >
              <img src={GithubImage} alt="GitHub" className="w-4 h-4 mr-2" />
              GitHub
            </a>
          </div>
        </header>

        {/* Search Bar */}
        <div className="mb-6">
          <div className="max-w-md mx-auto">
            <div className="relative">
              <input
                type="text"
                placeholder="Search documents, sections, or content..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-3 pl-10 pr-4 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>
            {searchQuery && (
              <div className="mt-2 text-sm text-gray-600 dark:text-gray-400 text-center">
                Found {filteredDocuments.length} of {documents.length} documents
              </div>
            )}
          </div>
        </div>

        {/* Documents List */}
        {filteredDocuments.length === 0 ? (
          <div className="text-center py-12">
            {searchQuery ? (
              <>
                <div className="text-gray-400 dark:text-gray-500 text-6xl mb-4">
                  
                </div>
                <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">
                  No documents found
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  Try adjusting your search terms
                </p>
                <button
                  onClick={() => setSearchQuery("")}
                  className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition duration-200"
                >
                  Clear Search
                </button>
              </>
            ) : (
              <>
                <div className="text-gray-400 dark:text-gray-500 text-6xl mb-4">
                  
                </div>
                <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">
                  No completed documents yet
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  Upload and process a PDF to see it here!
                </p>
                <Link
                  to="/"
                  className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition duration-200"
                >
                  Upload Your First PDF
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
              {searchQuery ? `Search Results (${filteredDocuments.length})` : `Completed Documents (${filteredDocuments.length})`}
            </h2>

            {filteredDocuments.map((doc) => (
              <DocumentCard
                key={doc.id}
                document={doc}
                sections={sections[doc.id] || []}
                searchQuery={searchQuery}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
