const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Credenziali Google (da variabili d'ambiente, MAI scritte qui) =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// ===== LOG DIAGNOSTICO TEMPORANEO (sicuro: non espone i valori reali) =====
function maschera(v) {
  if (!v) return 'MANCANTE (undefined/vuoto)';
  return `lunghezza=${v.length}, inizio="${v.slice(0, 6)}...", fine="...${v.slice(-6)}"`;
}
console.log('--- DIAGNOSTICA CREDENZIALI ALL\'AVVIO ---');
console.log('GOOGLE_CLIENT_ID:', maschera(CLIENT_ID));
console.log('GOOGLE_CLIENT_SECRET:', maschera(CLIENT_SECRET));
console.log('GOOGLE_REFRESH_TOKEN:', maschera(REFRESH_TOKEN));
console.log('-------------------------------------------');

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs  = google.docs({  version: 'v1', auth: oauth2Client });

// ===== Client OpenAI (da variabile d'ambiente) =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Endpoint principale =====
app.post('/api/genera', async (req, res) => {
  try {
    const { paziente, richiesta } = req.body;

    if (!paziente || !paziente.nome || !paziente.cognome) {
      return res.status(400).json({ success: false, error: 'Dati paziente mancanti (nome/cognome).' });
    }
    if (!richiesta || !richiesta.trim()) {
      return res.status(400).json({ success: false, error: 'Specificare cosa generare (campo "richiesta").' });
    }

    console.log(`--> Richiesta per ${paziente.nome} ${paziente.cognome}: "${richiesta}"`);

    // 1. Genera il contenuto testuale con OpenAI
    const promptSistema = `Sei un assistente che aiuta uno psicoterapeuta a redigere documenti clinici professionali in italiano.
Scrivi in modo chiaro, professionale e clinicamente appropriato.
Non inventare informazioni cliniche specifiche non fornite: se mancano dati, lascia indicazioni generiche o segnaposto tra parentesi quadre (es. [da completare]).
Restituisci SOLO il testo del documento, senza markdown, senza intestazioni tipo "Ecco il documento", pronto per essere inserito in un Google Doc.`;

    const promptUtente = `Paziente: ${paziente.nome} ${paziente.cognome}
Tipo di terapia: ${paziente.tipo_terapia || 'non specificato'}
Note generali sul paziente: ${paziente.note || 'nessuna nota disponibile'}

Richiesta dello specialista: ${richiesta}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: promptSistema },
        { role: 'user', content: promptUtente },
      ],
      temperature: 0.4,
    });

    const testoGenerato = completion.choices[0]?.message?.content?.trim();

    if (!testoGenerato) {
      throw new Error('OpenAI non ha restituito alcun contenuto.');
    }

    // 2. Crea un nuovo Google Doc da zero (nessun template)
    const nuovoDoc = await docs.documents.create({
      requestBody: {
        title: `${paziente.nome} ${paziente.cognome} - ${new Date().toLocaleDateString('it-IT')}`,
      },
    });

    const nuovoDocId = nuovoDoc.data.documentId;

    // 3. Inserisce il testo generato nel documento
    await docs.documents.batchUpdate({
      documentId: nuovoDocId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: testoGenerato,
            },
          },
        ],
      },
    });

    // 4. Recupera il link del documento
    const info = await drive.files.get({
      fileId: nuovoDocId,
      fields: 'webViewLink',
    });

    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error('Errore:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
