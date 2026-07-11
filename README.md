# Magazzino AR

Prima versione funzionante di una PWA per la gestione di prodotti e posizioni di magazzino tramite barcode, QR e guida visiva con fotocamera.

## Funzioni incluse

- scansione di barcode 1D e codici QR;
- inserimento manuale del codice come alternativa;
- anagrafica prodotti con foto, quantità, unità, lotto, scadenza e scorta minima;
- anagrafica delle posizioni: magazzino, zona, corsia, scaffale, ripiano e posto;
- generazione e stampa del QR di ogni posizione;
- entrate, uscite, rettifiche e spostamenti;
- storico completo con data e operatore;
- ricerca prodotto e guida AR assistita con verifica del QR corretto;
- archivio offline tramite IndexedDB;
- librerie barcode e QR caricate da CDN alla prima apertura e memorizzate dal browser/service worker nelle aperture successive;
- installazione sul telefono come PWA;
- esportazione e importazione del backup JSON;
- dati dimostrativi caricabili dalle impostazioni.

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
5. Per ritrovare il prodotto usa **Trova → Apri guida con fotocamera**.
6. Quando arrivi allo scaffale, scansiona il QR: l’app conferma se la posizione è corretta.

## Formato dei QR di posizione

Il contenuto generato è:

```text
MAGAR:LOC:CODICE-POSIZIONE
```

Esempio:

```text
MAGAR:LOC:M1-B-04-12-03-02
```

## Limite della prima versione

Ogni scheda prodotto rappresenta una sola giacenza e una sola posizione. Lo spostamento trasferisce quindi l’intera quantità. Per gestire lo stesso barcode contemporaneamente in più scaffali servirà il modulo successivo basato su lotti o unità di carico separate.

La guida AR di questa versione usa la fotocamera e la verifica del QR dello scaffale. Non salva ancora un oggetto tridimensionale persistente nello spazio: questa funzione richiede un modulo WebXR/ARCore dedicato e dispositivi compatibili.

## Dati e privacy

I dati restano nell’IndexedDB del browser usato. L’interfaccia e l’archivio funzionano offline; per assicurare anche il caricamento delle librerie esterne, apri almeno una volta l’app online dopo la pubblicazione. La cancellazione dei dati del sito o la disinstallazione possono rimuovere l’archivio. Usa periodicamente **Impostazioni → Esporta backup**.

Per l’utilizzo contemporaneo da più telefoni sarà necessario collegare l’app a un database centralizzato con autenticazione e permessi utente.
