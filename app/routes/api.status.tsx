import type { Route } from "./+types/api.status";
import * as schema from "~/database/schema";
import { eq } from "drizzle-orm";

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  const action = url.searchParams.get("action");

  if (!documentId) {
    return Response.json({ error: "Document ID required" }, { status: 400 });
  }

  try {
    const docId = parseInt(documentId);
    
    if (action === "download-toc") {
      // Handle table of contents download
      const document = await context.db.query.documents.findFirst({
        where: (documents, { eq }) => eq(documents.id, docId)
      });

      if (!document || !document.tableOfContents) {
        return new Response("Table of contents not available", { status: 404 });
      }

      const toc = JSON.parse(document.tableOfContents);
      const tocText = generateTocText(toc, document.originalName);
      
      return new Response(tocText, {
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": `attachment; filename="${document.originalName.replace('.pdf', '')}_table_of_contents.txt"`
        }
      });
    }

    if (action === "download-toc-json") {
      // Handle table of contents JSON download
      const document = await context.db.query.documents.findFirst({
        where: (documents, { eq }) => eq(documents.id, docId)
      });

      if (!document || !document.tableOfContents) {
        return new Response("Table of contents not available", { status: 404 });
      }

      const toc = JSON.parse(document.tableOfContents);
      const tocData = {
        document: document.originalName,
        generated: new Date().toISOString(),
        sections: toc
      };
      
      return new Response(JSON.stringify(tocData, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${document.originalName.replace('.pdf', '')}_table_of_contents.json"`
        }
      });
    }

    // Default: Return detailed status information
    const document = await context.db.query.documents.findFirst({
      where: (documents, { eq }) => eq(documents.id, docId)
    });

    if (!document) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }

    // Get sections if any exist (completed or in progress)
    let sections = [];
    if (document.status === 'completed' || document.status === 'processing') {
      sections = await context.db.query.sections.findMany({
        where: (sectionsTable, { eq }) => eq(sectionsTable.documentId, docId),
        orderBy: (sectionsTable, { asc }) => [asc(sectionsTable.sectionNumber)]
      });
    }

    // Parse outline if available
    let outline = null;
    if (document.tableOfContents) {
      try {
        outline = JSON.parse(document.tableOfContents);
      } catch (error) {
        console.error('Error parsing table of contents:', error);
      }
    }

    // Parse processing data if available (for continuation after approval)
    let processingData = null;
    if (document.processingData) {
      try {
        processingData = JSON.parse(document.processingData);
      } catch (error) {
        console.error('Error parsing processing data:', error);
      }
    }

    return Response.json({
      document: {
        id: document.id,
        originalName: document.originalName,
        status: document.status,
        currentStep: document.currentStep,
        progress: document.progress,
        statusMessage: document.statusMessage,
        hasTableOfContents: !!document.tableOfContents,
        tocGeneratedAt: document.tocGeneratedAt,
        createdAt: document.createdAt,
        completedAt: document.completedAt,
        errorMessage: document.errorMessage,
        pdfTitle: document.pdfTitle,
        pdfAuthor: document.pdfAuthor
      },
      outline,
      processingData,
      sections: sections.map(section => ({
        id: section.id,
        title: section.title,
        summary: section.summary,
        startPage: section.startPage,
        endPage: section.endPage,
        sectionNumber: section.sectionNumber
      }))
    });

  } catch (error) {
    console.error("Status API error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

function generateTocText(toc: any[], documentName: string): string {
  const lines = [
    `TABLE OF CONTENTS`,
    `Document: ${documentName}`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `─────────────────────────────────────────────────────`,
    ``
  ];

  toc.forEach((section, index) => {
    const pageRange = section.start_page === section.end_page 
      ? `Page ${section.start_page}`
      : `Pages ${section.start_page}-${section.end_page}`;
    
    lines.push(`${index + 1}. ${section.title}`);
    lines.push(`   ${pageRange}`);
    lines.push(``);
  });

  lines.push(`─────────────────────────────────────────────────────`);
  lines.push(`End of Table of Contents`);

  return lines.join('\n');
} 