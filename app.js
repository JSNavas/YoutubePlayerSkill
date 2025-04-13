require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const ytdl = require('@distube/ytdl-core');

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

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Función para buscar un video en YouTube por nombre
async function searchYouTube(query) {
  const apiKey = YOUTUBE_API_KEY;
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${apiKey}`;
  try {
    const response = await axios.get(url);
    if (response.data.items && response.data.items.length > 0) {
      const videoId = response.data.items[0].id.videoId;
      return `https://www.youtube.com/watch?v=${videoId}`;
    } else {
      return null;
    }
  } catch (error) {
    console.error("Error buscando en YouTube:", error);
    return null;
  }
}

// Función para obtener la URL del stream de audio (preferiblemente M4A) usando @distube/ytdl-core
async function getYouTubeAudioUrl(videoUrl) {
  try {
    const info = await ytdl.getInfo(videoUrl, {
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"
        }
      }
    });
    console.log("Información del video obtenido:", info.videoDetails.title);
    // Filtrar formatos: que tengan audio y sean de formato M4A o contengan "audio/mp4"
    const audioFormats = info.formats.filter(fmt => {
      const tieneAcodec = fmt.hasAudio || (fmt.acodec && fmt.acodec !== 'none');
      const esMp4 = fmt.ext === 'm4a' || (fmt.mimeType && fmt.mimeType.includes("audio/mp4"));
      return tieneAcodec && esMp4;
    });
    if (audioFormats && audioFormats.length > 0) {
      // Ordenar los formatos por bitrate (abr) de forma descendente
      audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
      const chosenFormat = audioFormats[0];
      console.log("Formato de audio elegido:", chosenFormat.itag, chosenFormat.mimeType, chosenFormat.abr);
      return chosenFormat.url;
    }
    console.error("No se encontraron formatos de audio compatibles.");
    return null;
  } catch (error) {
    console.error("Error extrayendo audio con @distube/ytdl-core:", error);
    return null;
  }
}

// Endpoint proxy para retransmitir el contenido de audio y agregar headers necesarias para reproducir en Alexa
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
            text: "Bienvenido a YouTube Player Skill. Dime el nombre de la cancion que quieres escuchar."
          },
          shouldEndSession: false
        }
      };
    } else if (requestType === 'IntentRequest') {
      const intentName = req.body.request.intent.name;
      // Manejo de PlayYouTubeIntent: busca y reproduce nueva canción
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
            // Genera un token único y actualiza el estado de reproducción
            playbackState.token = uuidv4();
            playbackState.url = audioUrl;
            playbackState.offsetInMilliseconds = 0; // Reinicia a 0 para una nueva canción
            playbackState.videoQuery = videoQuery;
            
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
      else if(intentName === 'ChangeSongIntent') {
        // Respuesta para cambiar de canción
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
      // Manejo de AMAZON.PauseIntent: detener la reproducción
      else if (intentName === 'AMAZON.PauseIntent' || intentName === 'AMAZON.StopIntent') {
        // simplemente detenemos la reproducción.
        // Nota: Para una verdadera funcionalidad de pausa/resume se requeriría capturar el offset
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
      // Manejo de AMAZON.ResumeIntent: reanudar la reproducción desde el offset guardado
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
                      token: playbackState.token, // utilizamos el mismo token
                      url: proxyUrl,
                      offsetInMilliseconds: playbackState.offsetInMilliseconds // si se hubiera guardado el offset
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
      // Manejo para Cancelar o Detener la skill
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
      // Otros intents o fallback
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
