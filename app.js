require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const youtubedl = require('youtube-dl-exec');

const app = express();
app.use(bodyParser.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const PROXY_BASE_URL = process.env.PROXY_BASE_URL;

// Variable global para almacenar el estado de reproducción
let playbackState = {
  token: null,
  url: null,
  offsetInMilliseconds: 0,
  videoQuery: ""
};

// Función para generar un UUID (para token único)
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    let r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Función para buscar un video en YouTube por nombre utilizando la YouTube Data API v3
async function searchYouTube(query) {
  const apiKey = YOUTUBE_API_KEY;
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${apiKey}`;
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (response.data.items && response.data.items.length > 0) {
      const videoId = response.data.items[0].id.videoId;
      return `https://www.youtube.com/watch?v=${videoId}`;
    } else {
      return null;
    }
  } catch (error) {
    console.error("Error buscando en YouTube:", error.response?.data || error);
    return null;
  }
}

// Función para obtener la URL del stream de audio (preferiblemente M4A) usando youtube-dl-exec
async function getYouTubeAudioUrl(videoUrl) {
  try {
    const output = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      format: 'bestaudio',
      // Pasa la ruta de tu archivo de cookies exportadas desde el navegador con la extensión de cookies.txt
      cookies: './cookies.txt'
    });

    console.log("Información del video obtenido:", output.title);
    
    // Filtra los formatos que tengan audio y sean compatibles (preferiblemente M4A)
    const audioFormats = output.formats.filter(fmt => {
      const tieneAcodec = fmt.acodec && fmt.acodec !== 'none';
      const esMp4 = fmt.ext === 'm4a' || (fmt.mimeType && fmt.mimeType.includes("audio/mp4"));
      return tieneAcodec && esMp4;
    });
    
    if (audioFormats && audioFormats.length > 0) {
      // Ordena por bitrate (abr) de forma descendente
      audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
      const chosenFormat = audioFormats[0];
      console.log("Formato de audio elegido:", chosenFormat);
      return chosenFormat.url;
    }
    console.error("No se encontraron formatos de audio compatibles.");
    return null;
  } catch (error) {
    console.error("Error extrayendo audio con youtube-dl-exec:", error);
    return null;
  }
}


// Endpoint proxy para retransmitir el contenido de audio y agregar los encabezados necesarios para Alexa
app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send("Falta el parámetro 'url'");
    }
    const response = await axios.get(targetUrl, { responseType: 'stream' });
    res.setHeader('Content-Type', response.headers['content-type'] || 'audio/mp4');
    response.data.pipe(res);
  } catch (error) {
    console.error("Error proxying audio:", error);
    res.sendStatus(500);
  }
});

// Handler para las solicitudes de Alexa
app.post('/alexa', async (req, res) => {
  let responseJson = {};
  try {
    const requestType = req.body.request.type;
    if (requestType === 'LaunchRequest') {
      responseJson = {
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Bienvenido a YouTube Player Skill. Dime el nombre de la canción que quieres escuchar."
          },
          shouldEndSession: false
        }
      };
    } else if (requestType === 'IntentRequest') {
      const intentName = req.body.request.intent.name;
      
      // Intent para reproducir una canción (PlayYouTubeIntent)
      if (intentName === 'PlayYouTubeIntent') {
        const videoQuery = req.body.request.intent.slots.videoQuery.value;
        const videoUrl = await searchYouTube(videoQuery);
        if (!videoUrl) {
          responseJson = {
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: "No pude encontrar un video para esa búsqueda. Por favor, intenta con otro término."
              },
              shouldEndSession: false
            }
          };
        } else {
          const audioUrl = await getYouTubeAudioUrl(videoUrl);
          if (!audioUrl) {
            responseJson = {
              version: "1.0",
              response: {
                outputSpeech: {
                  type: "PlainText",
                  text: "No pude extraer el audio del video. Por favor, intenta con otro."
                },
                shouldEndSession: false
              }
            };
          } else {
            // Actualiza el estado de reproducción con un token único
            playbackState.token = uuidv4();
            playbackState.url = audioUrl;
            playbackState.offsetInMilliseconds = 0; // Nueva canción, reinicia el offset
            playbackState.videoQuery = videoQuery;
            
            // Construye el URL del proxy
            const proxyUrl = `${PROXY_BASE_URL}/proxy?url=${encodeURIComponent(audioUrl)}`;
            responseJson = {
              version: "1.0",
              response: {
                card: {
                  type: "Simple",
                  title: "YouTube Player",
                  content: "Reproduciendo: " + videoQuery
                },
                outputSpeech: {
                  type: "PlainText",
                  text: "Reproduciendo: " + videoQuery
                },
                directives: [
                  {
                    type: "AudioPlayer.Play",
                    playBehavior: "REPLACE_ALL",
                    audioItem: {
                      stream: {
                        token: playbackState.token,
                        url: proxyUrl,
                        offsetInMilliseconds: playbackState.offsetInMilliseconds
                      }
                    }
                  }
                ],
                shouldEndSession: true
              }
            };
          }
        }
      }
      // Intent para cambiar de canción (ChangeSongIntent)
      else if (intentName === 'ChangeSongIntent') {
        // Responde con un outputSpeech preguntando por la nueva canción; deja la sesión abierta
        responseJson = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "¿Qué canción deseas escuchar ahora?"
            },
            shouldEndSession: false
          }
        };
      }
      // Intent para pausar la reproducción
      else if (intentName === 'AMAZON.PauseIntent' || intentName === 'AMAZON.StopIntent') {
        responseJson = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "Pausando la reproducción."
            },
            directives: [
              {
                type: "AudioPlayer.Stop"
              }
            ],
            shouldEndSession: true
          }
        };
      }
      // Intent para reanudar la reproducción
      else if (intentName === 'AMAZON.ResumeIntent') {
        if (playbackState.url) {
          const proxyUrl = `${PROXY_BASE_URL}/proxy?url=${encodeURIComponent(playbackState.url)}`;
          responseJson = {
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: "Reanudando la reproducción de " + playbackState.videoQuery
              },
              directives: [
                {
                  type: "AudioPlayer.Play",
                  playBehavior: "REPLACE_ALL",
                  audioItem: {
                    stream: {
                      token: playbackState.token,
                      url: proxyUrl,
                      offsetInMilliseconds: playbackState.offsetInMilliseconds
                    }
                  }
                }
              ],
              shouldEndSession: true
            }
          };
        } else {
          responseJson = {
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: "No hay ninguna reproducción para reanudar. Por favor, busca una canción."
              },
              shouldEndSession: false
            }
          };
        }
      }
      // Intent para cancelar la skill
      else if (intentName === 'AMAZON.CancelIntent') {
        responseJson = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "Gracias por usar YouTube Player Skill. ¡Hasta pronto!"
            },
            directives: [
              {
                type: "AudioPlayer.Stop"
              }
            ],
            shouldEndSession: true
          }
        };
      }
      // Fallback para intents no reconocidos
      else {
        responseJson = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "No he entendido tu solicitud. Por favor, intenta de nuevo."
            },
            shouldEndSession: false
          }
        };
      }
    } else {
      responseJson = {
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Lo siento, algo salió mal."
          },
          shouldEndSession: true
        }
      };
    }
    res.json(responseJson);
  } catch (err) {
    console.error("Error procesando la solicitud:", err);
    res.json({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: "Ocurrió un error al procesar tu solicitud."
        },
        shouldEndSession: true
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
