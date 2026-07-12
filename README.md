# Magazzino AR

Prima versione funzionante di una PWA per la gestione di prodotti e posizioni di magazzino tramite barcode, QR e guida visiva con fotocamera.

## Funzioni incluse

- scansione di barcode 1D e codici QR;
- inserimento manuale del codice come alternativa;
- anagrafica prodotti con foto, quantità, unità, lotto, scadenza e scorta minima;
- anagrafica delle posizioni: magazzino, zona, corsia, scaffale, ripiano e posto;
- generazione e stampa del QR di ogni posizione;
- generazione e stampa di un QR stabile per ogni prodotto;
- scansione del QR prodotto per aprire direttamente la scheda “Trova” e vedere la posizione aggiornata;
- entrate, uscite, rettifiche e spostamenti;
- storico completo con data e operatore;
- ricerca prodotto e guida AR assistita con verifica del QR corretto;
- archivio offline tramite IndexedDB;
- installazione sul telefono come PWA;
- esportazione e importazione del backup JSON;
- dati dimostrativi caricabili dalle impostazioni.

## Correzione QR offline (versione 4)

Il generatore QR è ora incluso direttamente nel progetto nel file `qrcode-local.js`. Non dipende più da un collegamento CDN esterno e funziona anche quando il telefono è offline o blocca librerie esterne. Dopo aver sostituito i file su GitHub Pages, chiudi completamente la PWA e riaprila; se appare ancora la versione precedente, cancella la cache del sito o disinstalla e reinstalla l’app.

## Come provarla sul computer

La fotocamera e la PWA richiedono un server web. Non aprire direttamente `index.html` con doppio clic.

### Metodo rapido con Python

Apri il terminale dentro la cartella del progetto ed esegui:

```bash
python -m http.server 8080
```

Poi apri:

```text
http://localhost:8080
```

Su `localhost` la fotocamera è normalmente consentita anche senza HTTPS.

## Come pubblicarla su GitHub Pages

1. Crea un nuovo repository GitHub.
2. Carica tutti i file mantenendo la cartella `icons`.
3. Apri **Settings → Pages**.
4. In **Build and deployment** scegli **Deploy from a branch**.
5. Seleziona il branch `main` e la cartella `/root`.
6. Apri il link HTTPS generato da GitHub Pages.

## Preparazione del magazzino

1. Apri **Posizioni** e crea ogni punto fisico.
2. Usa **Stampa QR** sulla scheda della posizione.
3. Applica l’etichetta QR sul relativo scaffale o posto.
4. Apri **Prodotti**, scansiona il barcode e assegna una posizione.
5. Nella scheda del prodotto premi **QR** e stampa l’etichetta da applicare sulla confezione o sul contenitore.
6. Quando scansioni quel QR, l’app apre direttamente **Trova** e mostra la posizione corrente.
7. Per raggiungere il prodotto usa **Apri guida con fotocamera**.
8. Quando arrivi allo scaffale, scansiona il QR della posizione: l’app conferma se il punto è corretto.

## Formato dei QR di posizione

Il contenuto generato è:

```text
MAGAR:LOC:CODICE-POSIZIONE
```

Esempio:

```text
MAGAR:LOC:M1-B-04-12-03-02
```


## Formato dei QR prodotto

Il contenuto generato è:

```text
MAGAR:PROD:ID-INTERNO-PRODOTTO
```

L’identificativo resta stabile anche se modifichi nome, quantità o posizione. La scritta della posizione stampata sull’etichetta è un riferimento visivo; scansionando il QR l’app mostra sempre la posizione più recente salvata nell’archivio.

Il QR del prodotto può essere usato anche nelle operazioni di entrata, uscita e spostamento, oltre che nella ricerca.

## Limite della prima versione

Ogni scheda prodotto rappresenta una sola giacenza e una sola posizione. Lo spostamento trasferisce quindi l’intera quantità. Per gestire lo stesso barcode contemporaneamente in più scaffali servirà il modulo successivo basato su lotti o unità di carico separate.

La guida AR di questa versione usa la fotocamera e la verifica del QR dello scaffale. Non salva ancora un oggetto tridimensionale persistente nello spazio: questa funzione richiede un modulo WebXR/ARCore dedicato e dispositivi compatibili.

## Dati e privacy

I dati restano nell’IndexedDB del browser usato. La cancellazione dei dati del sito o la disinstallazione possono rimuovere l’archivio. Usa periodicamente **Impostazioni → Esporta backup**.

Per l’utilizzo contemporaneo da più telefoni sarà necessario collegare l’app a un database centralizzato con autenticazione e permessi utente.

## Correzione versione 5.1

Questa versione corregge il blocco dei pulsanti **Nuovo prodotto**, **Nuova posizione** e degli strumenti nelle **Impostazioni**. Il problema era causato da file HTML e JavaScript non allineati. Sono stati inoltre aggiunti:

- pulsanti QR mancanti nei moduli;
- controlli JavaScript che evitano il blocco totale in caso di elemento mancante;
- risorse con versione per evitare vecchi file nella cache;
- service worker aggiornato con priorità ai file più recenti.

Dopo la pubblicazione aprire una volta l'indirizzo con `?v=5.1.0`, quindi chiudere e riaprire l'app.
