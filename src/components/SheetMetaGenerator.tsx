import React, { useState } from 'react';
import Papa from 'papaparse'; // CSV parsing library
import OpenAI from 'openai'; // OpenAI API client

// Load OpenAI API key from environment variables (Vite specific)
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
let openai: OpenAI | null = null;

// Initialize OpenAI client if API key is available
if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    dangerouslyAllowBrowser: true, // Required for client-side browser usage
  });
} else {
  // Log a warning if the API key is missing, as core functionality will be disabled
  console.warn("VITE_OPENAI_API_KEY is not set in .env. OpenAI functionality will be disabled.");
}

/**
 * Interface defining the structure for each row in the results table,
 * representing a URL and its processing status/results.
 */
interface MetaTagRow {
  id: number; // Unique identifier for the row
  url: string; // The original URL from the Google Sheet
  title?: string; // Generated meta title
  description?: string; // Generated meta description
  // Status of processing for this URL
  status: 'pending' | 'loading-content' | 'generating' | 'success' | 'error-fetch' | 'error-openai' | 'error-sheet';
  errorMessage?: string; // Error message if processing failed
}

const SheetMetaGenerator: React.FC = () => {
  // State for the Google Sheet URL input by the user
  const [sheetUrl, setSheetUrl] = useState<string>('');
  const [metaData, setMetaData] = useState<MetaTagRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handleUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSheetUrl(event.target.value);
  };

  /**
   * Handles the form submission to start processing the Google Sheet.
   * It parses the URL, fetches CSV data, then initiates URL content fetching and OpenAI processing.
   */
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); // Prevent default form submission

    // Validate Google Sheet URL input
    if (!sheetUrl.trim()) {
      setGlobalError('Please enter a Google Sheet URL.');
      return;
    }
    setGlobalError(null); // Clear any previous global errors
    setMetaData([]); // Clear previous results from the table

    // Check if OpenAI API key is configured
    if (!OPENAI_API_KEY || !openai) {
      setGlobalError('OpenAI API key (VITE_OPENAI_API_KEY) is not configured. Please set it in your .env file.');
      setIsLoading(false);
      return;
    }

    setIsLoading(true); // Indicate that processing has started

    // Attempt to parse the input URL to a direct CSV export link
    const csvUrl = parseGoogleSheetUrl(sheetUrl);
    if (!csvUrl) {
      setGlobalError('Invalid Google Sheet URL. Please use a valid link (e.g., docs.google.com/spreadsheets/d/ID/edit or /export?format=csv).');
      setIsLoading(false);
      return;
    }

    console.log('Attempting to fetch from CSV URL:', csvUrl);

    try {
      // Fetch the CSV data from the Google Sheet
      const response = await fetch(csvUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch Google Sheet CSV: ${response.status} ${response.statusText}`);
      }
      const csvText = await response.text(); // Get CSV content as text

      // Parse the CSV text using Papaparse
      Papa.parse(csvText, {
        header: false, // Treat rows as arrays, not objects with headers
        skipEmptyLines: true, // Ignore any empty lines in the CSV
        complete: (results) => { // Callback when parsing is complete
          // Extract URLs from the first column (index 0) of each row
          const urls: string[] = results.data
            .map((row: any) => row[0])
            .filter((url): url is string => typeof url === 'string' && url.trim().startsWith('http')); // Basic validation

          if (urls.length === 0) {
            setGlobalError('No valid URLs found in the first column of the Google Sheet.');
            setMetaData([]);
            setIsLoading(false);
            return;
          }

          // Prepare initial data structure for the results table
          const initialMetaData: MetaTagRow[] = urls.map((url, index) => ({
            id: index + 1,
            url: url,
            status: 'pending', // Initial status for each URL
          }));
          setMetaData(initialMetaData); // Update table with pending URLs

          // Start processing each extracted URL (fetch content, call OpenAI)
          console.log('Extracted URLs:', urls);
          processUrls(initialMetaData);
        },
        error: (error: any) => { // Callback if Papaparse encounters an error
          console.error("CSV Parsing Error:", error);
          setGlobalError(`Error parsing CSV data from Google Sheet: ${error.message}`);
          setMetaData([]);
          setIsLoading(false);
        }
      });
    } catch (error: any) { // Catch errors from fetching the CSV
      console.error("Fetch/Parse Error:", error);
      setGlobalError(`Error fetching or parsing Google Sheet: ${error.message}`);
      setMetaData([]);
      // setIsLoading(false); // isLoading will be managed by processUrls if it starts
    }
  };

  /**
   * Processes an array of MetaTagRow objects. For each row, it:
   * 1. Fetches content from the URL (via CORS proxy).
   * 2. Strips HTML to get text.
   * 3. Calls OpenAI API to generate meta title and description.
   * Updates the state (`metaData`) progressively to reflect the status of each URL.
   */
  const processUrls = async (rows: MetaTagRow[]) => {
    setIsLoading(true); // Set global loading state for the duration of processing all URLs
    let currentData = [...rows]; // Create a mutable copy of the rows

    // Process each URL sequentially to avoid overwhelming the browser or hitting rate limits too quickly
    for (let i = 0; i < currentData.length; i++) {
      const row = currentData[i];
      try {
        // Update status to 'loading-content' for the current URL
        currentData = currentData.map(r => r.id === row.id ? { ...r, status: 'loading-content' } : r);
        setMetaData([...currentData]); // Update UI

        // Use a CORS proxy to fetch URL content from the client-side
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(row.url)}`;
        const response = await fetch(proxyUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch content via proxy: ${response.status} ${response.statusText}`);
        }
        const htmlContent = await response.text();

        // Extract text content from HTML, limit length for OpenAI prompt
        const textContent = stripHtml(htmlContent).substring(0, 4000);

        // Update status to 'generating' (for OpenAI call)
        currentData = currentData.map(r => r.id === row.id ? { ...r, status: 'generating' } : r);
        setMetaData([...currentData]); // Update UI

        if (!openai) {
          throw new Error("OpenAI client is not initialized. Check API key.");
        }
        if (!textContent.trim()) { // Check if any meaningful content was extracted
          throw new Error("No text content extracted from URL to send to OpenAI.");
        }

        // Construct the prompt for OpenAI
        const prompt = `Generate a concise and SEO-friendly meta title (max 60 characters) and meta description (max 160 characters) for the following web page content. Return the response as a JSON object with "title" and "description" keys. Content:\n\n${textContent}`;

        // Call OpenAI API
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7, // Controls randomness: lower is more deterministic
          max_tokens: 150,  // Max tokens for the generated title and description + JSON structure
          response_format: { type: "json_object" }, // Request JSON output from OpenAI
        });

        const result = completion.choices[0]?.message?.content;
        if (!result) {
          throw new Error('No response content from OpenAI.');
        }

        // Attempt to parse the JSON response from OpenAI
        try {
          const parsedResult = JSON.parse(result);
          if (parsedResult.title && parsedResult.description) {
            // Update row with generated title, description, and success status
            currentData = currentData.map(r => r.id === row.id ? {
              ...r,
              status: 'success',
              title: parsedResult.title,
              description: parsedResult.description
            } : r);
          } else {
            // If JSON is valid but missing expected fields
            throw new Error('Invalid JSON format from OpenAI (missing title or description).');
          }
        } catch (parseError: any) { // Catch errors from parsing OpenAI's JSON response
          console.error('Error parsing OpenAI response:', parseError, "Raw content:", result);
          throw new Error(`Failed to parse meta tags from AI. Raw: ${result.substring(0,100)}...`);
        }
        setMetaData([...currentData]); // Update UI with successful result or parsing error

      } catch (error: any) { // Catch errors during fetching content or calling OpenAI for a specific URL
        console.error(`Error processing URL ${row.url}:`, error);
        // Determine if the error was during OpenAI call or content fetching
        const statusOnError = currentData.find(r => r.id === row.id)?.status === 'generating' ? 'error-openai' : 'error-fetch';
        // Update row with error status and message
        currentData = currentData.map(r => r.id === row.id ? { ...r, status: statusOnError, errorMessage: error.message } : r);
        setMetaData([...currentData]); // Update UI
      }
    }
    setIsLoading(false); // All URLs have been processed (or failed)
  };

  /**
   * Basic HTML stripping function.
   * Uses DOMParser to convert HTML string to a DOM document, then extracts text.
   * This is a simplified approach and may not perfectly capture all relevant content
   * from complex web pages.
   */
  const stripHtml = (html: string): string => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    if (body) {
        // Remove script and style elements to avoid their content in the output
        body.querySelectorAll('script, style').forEach(el => el.remove());

        let text = '';
        // Select common content-holding elements and concatenate their text
        body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, article, section, div').forEach(el => {
            const blockText = el.textContent?.trim();
            if (blockText) {
                text += blockText + '\n\n'; // Add double newlines to simulate paragraph breaks
            }
        });
        return text.replace(/\s\s+/g, ' ').trim(); // Clean up extra whitespace
    }
    return ''; // Fallback if body is not found or no text extracted
  };

  /**
   * Helper function to parse various Google Sheet URL formats and construct
   * a direct CSV export link.
   * Supports standard /edit URLs (with or without GID) and direct /export URLs.
   * @param url The Google Sheet URL input by the user.
   * @returns A string containing the CSV export URL, or null if parsing fails.
   */
  const parseGoogleSheetUrl = (url: string): string | null => {
    if (!url) return null;

    // If the URL is already a CSV export link, return it directly
    if (url.includes('/export?format=csv')) {
      return url;
    }

    // Regex to capture SHEET_ID and optionally GID from standard Google Sheet URLs
    // e.g., https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=GID_NUMBER
    // e.g., https://docs.google.com/spreadsheets/d/SHEET_ID/edit
    const regex = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)(?:\/edit(?:#gid=([0-9]+))?)?/;
    const matches = url.match(regex);

    if (matches && matches[1]) { // If regex matches and SHEET_ID is captured
      const sheetId = matches[1];
      const gid = matches[2]; // GID might be undefined if not present in the URL

      // Construct the CSV export URL
      let exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      if (gid) { // Append GID if it was captured
        exportUrl += `&gid=${gid}`;
      }
      return exportUrl;
    }

    // If no regex match, the URL format is not recognized or invalid
    return null;
  };

  return (
    <div className="sheet-meta-generator">
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="sheetUrl">Google Sheet URL (public CSV export link):</label>
          <input
            type="url"
            id="sheetUrl"
            value={sheetUrl}
            onChange={handleUrlChange}
            placeholder="https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv"
            required
          />
        </div>
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Processing...' : 'Generate Meta Tags'}
        </button>
      </form>

      {globalError && <p className="error-message global-error">{globalError}</p>}

      {metaData.length > 0 && (
        <div className="results-table-container">
          <h3>Generated Meta Tags:</h3>
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Generated Title</th>
                <th>Generated Description</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {metaData.map((row) => (
                <tr key={row.id} className={`status-${row.status}`}>
                  <td><a href={row.url} target="_blank" rel="noopener noreferrer">{row.url}</a></td>
                  <td>{row.title || 'N/A'}</td>
                  <td>{row.description || 'N/A'}</td>
                  <td>
                    {row.status === 'error-fetch' || row.status === 'error-openai' || row.status === 'error-sheet'
                      ? `${row.status}: ${row.errorMessage || 'Unknown error'}`
                      : row.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SheetMetaGenerator;
