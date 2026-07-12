# Magazzino AR – versione 6.0

Web app/PWA per gestire prodotti, posizioni, barcode, QR, movimenti e ricerca guidata.

## Novità della versione 6

- Area **Impostazioni protetta da PIN**.
- PIN richiesto anche prima di eliminare prodotti, eliminare posizioni, importare un backup o cancellare tutto.
- PIN iniziale: **1234**. Va cambiato subito dalle Impostazioni.
- Schede dei prodotti completamente cliccabili con finestra dettagliata.
- Schede delle posizioni completamente cliccabili con elenco dei prodotti presenti.
- Sincronizzazione automatica con **Cloudflare Workers + D1**.
- Funzionamento offline: i dati restano in IndexedDB e vengono inviati al cloud quando torna Internet.
- Coda automatica delle modifiche non ancora sincronizzate.

## Pubblicazione della web app

Carica nella cartella principale del repository GitHub Pages questi file:

- `index.html`
- `styles.css`
- `app.js`
- `db.js`
- `cloud.js`
- `qrcode-local.js`
- `sw.js`
- `manifest.webmanifest`
- cartella `icons`

La cartella `cloudflare-worker` non va caricata nella root della web app: serve per pubblicare separatamente l’API Cloudflare.

Dopo l’aggiornamento apri l’app aggiungendo una volta `?v=6.0.0` all’indirizzo, quindi chiudi e riapri la PWA.

## Primo accesso alle Impostazioni

1. Premi **Impostazioni**.
2. Inserisci il PIN iniziale `1234`.
3. Nella sezione **Protezione PIN**, scegli un nuovo codice da 4 a 12 cifre.
4. Premi **Cambia PIN**.

Il PIN è memorizzato in forma hash sul dispositivo. Non viene inserito nei backup e non viene inviato al database Cloudflare.

## Come funzionano le schede cliccabili

- Premi in un punto libero della scheda prodotto per aprire tutti i dettagli.
- I piccoli pulsanti QR, Trova, Movimenta, Modifica ed Elimina continuano a funzionare separatamente.
- Premi una scheda posizione per vedere percorso, indicazioni e prodotti presenti.
- Dalla scheda posizione puoi aprire direttamente il dettaglio di ciascun prodotto.

## Configurazione Cloudflare

Segui il file `cloudflare-worker/GUIDA-CLOUDFLARE.md`.

Al termine avrai:

- un URL simile a `https://magazzino-ar-api.nome-account.workers.dev`;
- una chiave segreta scelta durante la configurazione;
- un codice magazzino scelto da te, per esempio `cassino-reparto-1`.

Apri quindi **Impostazioni → Cloudflare D1** e inserisci:

- Indirizzo API Worker;
- Codice magazzino;
- Chiave di accesso.

Premi **Salva e sincronizza**. Se il cloud è vuoto, i dati già presenti sul telefono vengono caricati automaticamente. Se il cloud contiene dati, l’app li scarica sul dispositivo.

## Regole della sincronizzazione

- Ogni salvataggio, movimento o eliminazione viene accodato e inviato a Cloudflare.
- Senza Internet l’app continua a funzionare localmente.
- Al ritorno online la coda viene inviata automaticamente.
- Il pulsante **Sincronizza ora** forza un controllo completo.
- Più dispositivi possono usare lo stesso codice magazzino e la stessa chiave.
- In caso di modifiche contemporanee allo stesso record, prevale l’ultima modifica arrivata al server.

## Foto dei prodotti

Le foto vengono ridimensionate prima del salvataggio. Cloudflare D1 accetta fino a 2 MB per singolo record; se una vecchia foto fosse troppo grande, la sincronizzazione conserva i dati del prodotto ma può omettere quella foto dal cloud. Il prodotto rimane completo sul dispositivo locale.

## Backup consigliato

Anche con il cloud attivo, esegui periodicamente **Esporta backup**. Il backup JSON permette di ripristinare rapidamente l’intero archivio.
