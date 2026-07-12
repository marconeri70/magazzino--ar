# Magazzino AR – versione 5.2.0

Questa versione corregge definitivamente la creazione dei QR.

## Correzioni principali

- il generatore QR viene caricato dal file locale `qrcode-local.js` e non dipende da Internet;
- il QR viene prima mostrato in una finestra di anteprima;
- la creazione del QR non dipende più dalla funzione di stampa del telefono;
- sono disponibili i pulsanti **Scarica PNG**, **Condividi** e **Stampa**;
- su iBleem è consigliato usare **Scarica PNG** oppure **Condividi**;
- QR prodotto disponibile anche senza barcode commerciale;
- QR posizione disponibile subito dopo il salvataggio;
- cache PWA aggiornata alla versione 5.2.0.

## Pubblicazione su GitHub Pages

1. Sostituire nel repository tutti i file con quelli di questo pacchetto.
2. Verificare che `qrcode-local.js` sia presente nella stessa cartella di `index.html`.
3. Attendere l'aggiornamento di GitHub Pages.
4. Aprire il sito aggiungendo `?v=5.2.0` all'indirizzo.
5. Chiudere completamente la PWA già installata e riaprirla.

Non cancellare i dati del sito: prodotti e posizioni già salvati rimarranno disponibili se l'indirizzo GitHub Pages non cambia.
