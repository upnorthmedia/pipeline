from contextlib import asynccontextmanager
from pathlib import Path

from arq.connections import RedisSettings, create_pool
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.api.events import router as events_router
from src.api.links import router as links_router
from src.api.posts import router as posts_router
from src.api.profiles import router as profiles_router
from src.api.queue import router as queue_router
from src.api.rules import router as rules_router
from src.api.settings import router as settings_router
from src.config import settings
from src.database import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: create ArqRedis pool (supports enqueue_job)
    app.state.redis = await create_pool(
        RedisSettings.from_dsn(settings.redis_url)
    )
    yield
    # Shutdown
    await app.state.redis.aclose()
    await engine.dispose()


app = FastAPI(
    title="Content Pipeline API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(profiles_router)
app.include_router(links_router)
app.include_router(posts_router)
app.include_router(events_router)
app.include_router(settings_router)
app.include_router(queue_router)
app.include_router(rules_router)

# Serve generated images
media_path = Path(settings.media_dir)
media_path.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(media_path)), name="media")


@app.get("/health")
async def health():
    return {"status": "ok"}
