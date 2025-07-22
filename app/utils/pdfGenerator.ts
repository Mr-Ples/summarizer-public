// PDF Generation Utilities for Client-Side PDF Processing
// Uses pdf-lib for PDF manipulation and jspdf for text overlay

interface Section {
  title: string;
  start_page: number;
  end_page: number;
  summary: string;
}

interface PDFPage {
  pageNumber: number;
  content: Uint8Array;
}

/**
 * Extract specific page range from original PDF
 */
export async function extractPDFPages(
  base64Data: string, 
  startPage: number, 
  endPage: number
): Promise<Uint8Array> {
  try {
    console.log(`[PDF-GEN] Extracting pages ${startPage}-${endPage} from PDF`);
    
    // Load pdf-lib from CDN
    const { PDFDocument } = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
    
    // Convert base64 to Uint8Array
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Load the original PDF
    const originalPdf = await PDFDocument.load(bytes);
    const pageCount = originalPdf.getPageCount();
    
    console.log(`[PDF-GEN] Original PDF has ${pageCount} pages`);
    
    // Validate page ranges
    if (startPage < 1 || endPage > pageCount || startPage > endPage) {
      throw new Error(`Invalid page range: ${startPage}-${endPage} (PDF has ${pageCount} pages)`);
    }
    
    // Create new PDF document
    const newPdf = await PDFDocument.create();
    
    // Copy pages from original to new PDF
    for (let i = startPage - 1; i < endPage; i++) {
      const [copiedPage] = await newPdf.copyPages(originalPdf, [i]);
      newPdf.addPage(copiedPage);
    }
    
    // Save the new PDF
    const pdfBytes = await newPdf.save();
    console.log(`[PDF-GEN] Successfully extracted pages ${startPage}-${endPage} (${pdfBytes.length} bytes)`);
    
    return pdfBytes;
    
  } catch (error) {
    console.error('[PDF-GEN] Error extracting PDF pages:', error);
    throw error;
  }
}

/**
 * Create PDF with summary page + original pages
 */
export async function createSectionPDF(
  originalPages: Uint8Array,
  summary: string,
  title: string
): Promise<Uint8Array> {
  try {
    console.log(`[PDF-GEN] Creating section PDF for: ${title}`);
    
    // Load pdf-lib from CDN
    const { PDFDocument, rgb, StandardFonts } = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
    
    // Load the original pages PDF
    const pdfDoc = await PDFDocument.load(originalPages);
    
    // Create a new PDF
    const newPdf = await PDFDocument.create();
    
    // Add a blank summary page at the beginning
    const summaryPage = newPdf.addPage([595, 842]); // A4 size
    const { width, height } = summaryPage.getSize();
    
    // SUPER SIMPLE APPROACH - JUST FUCKING WORK
    // Clean the summary text to remove characters that WinAnsi can't encode
    let cleanSummary = summary
      .replaceAll("**", '') // Replace checkmarks with asterisks
      .replace(/✓/g, '*') // Replace checkmarks with asterisks
      .replace(/•/g, '*') // Replace bullets with asterisks
      .replace(/⊗/g, 'x') // Replace circled times with x
      .replace(/—/g, '-') // Replace em dashes with hyphens
      .replace(/'/g, "'") // Replace smart quotes with regular quotes
      .replace(/"/g, '"') // Replace smart quotes with regular quotes
      .replace(/…/g, '...') // Replace ellipsis with three dots
      .replace(/[^\x00-\x7F]/g, ''); // Remove any remaining non-ASCII characters

    const text = `Section: ${title}\n\nSummary:\n${cleanSummary}`;
    
    // Draw the entire text block in one go - let pdf-lib handle everything
    summaryPage.drawText(text, {
      x: 50,
      y: height - 100,
      size: 9,
      color: rgb(0, 0, 0),
      lineHeight: 12,
      maxWidth: width - 100,
    });
    
    // Copy all pages from the original PDF to the new PDF
    const pageCount = pdfDoc.getPageCount();
    for (let i = 0; i < pageCount; i++) {
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(copiedPage);
    }
    
    // Save the modified PDF
    const pdfBytes = await newPdf.save();
    console.log(`[PDF-GEN] Successfully created section PDF with summary page (${pdfBytes.length} bytes)`);
    
    return pdfBytes;
    
  } catch (error) {
    console.error('[PDF-GEN] Error creating section PDF:', error);
    throw error;
  }
}

/**
 * Generate PDF for a single section
 */
export async function generateSectionPDF(
  base64Data: string,
  section: Section
): Promise<Uint8Array> {
  try {
    console.log(`[PDF-GEN] Generating PDF for section: ${section.title}`);
    
    // Step 1: Extract the page range for this section
    const extractedPages = await extractPDFPages(
      base64Data,
      section.start_page,
      section.end_page
    );
    
    // Step 2: Add summary overlay to the extracted pages
    const sectionPDF = await createSectionPDF(
      extractedPages,
      section.summary,
      section.title
    );
    
    console.log(`[PDF-GEN] ✅ Successfully generated PDF for section: ${section.title}`);
    return sectionPDF;
    
  } catch (error) {
    console.error(`[PDF-GEN] ❌ Error generating PDF for section ${section.title}:`, error);
    throw error;
  }
}

/**
 * Generate PDFs for all sections
 */
export async function generateAllSectionPDFs(
  base64Data: string,
  sections: Section[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, Uint8Array>> {
  try {
    console.log(`[PDF-GEN] Generating PDFs for ${sections.length} sections`);
    
    const sectionPDFs = new Map<string, Uint8Array>();
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      
      console.log(`[PDF-GEN] Processing section ${i + 1}/${sections.length}: ${section.title}`);
      
      // Update progress callback
      if (onProgress) {
        onProgress(i + 1, sections.length);
      }
      
      // Generate PDF for this section
      const pdfBytes = await generateSectionPDF(base64Data, section);
      sectionPDFs.set(section.title, pdfBytes);
      
      // Add small delay to prevent overwhelming the browser
      if (i < sections.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`[PDF-GEN] ✅ Successfully generated PDFs for all ${sections.length} sections`);
    return sectionPDFs;
    
  } catch (error) {
    console.error('[PDF-GEN] ❌ Error generating section PDFs:', error);
    throw error;
  }
}

/**
 * Stitch multiple section PDFs into a single PDF
 */
export async function stitchSectionPDFs(sectionPDFs: Uint8Array[]): Promise<Uint8Array> {
  try {
    // Load pdf-lib from CDN
    const { PDFDocument } = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');

    // Create a new PDF document
    const stitchedPdf = await PDFDocument.create();

    for (const pdfBytes of sectionPDFs) {
      const pdf = await PDFDocument.load(pdfBytes);
      const pageCount = pdf.getPageCount();
      const copiedPages = await stitchedPdf.copyPages(pdf, Array.from({ length: pageCount }, (_, i) => i));
      copiedPages.forEach(page => stitchedPdf.addPage(page));
    }

    const finalPdfBytes = await stitchedPdf.save();
    return finalPdfBytes;
  } catch (error) {
    console.error('[PDF-GEN] Error stitching section PDFs:', error);
    throw error;
  }
}

/**
 * Download PDF as file
 */
export function downloadPDF(pdfBytes: Uint8Array, filename: string): void {
  try {
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up
    URL.revokeObjectURL(url);
    
    console.log(`[PDF-GEN] Downloaded PDF: ${filename}`);
  } catch (error) {
    console.error('[PDF-GEN] Error downloading PDF:', error);
    throw error;
  }
} 