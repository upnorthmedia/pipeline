import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from src.database import get_session
from src.main import app
from src.models import Base


@pytest.fixture
def anyio_backend():
    return "asyncio"


TEST_DATABASE_URL = (
    "postgresql+asyncpg://pipeline:pipeline@localhost:5433/content_pipeline_test"
)


@pytest.fixture
async def db_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture
async def db_session(db_engine):
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
        await session.rollback()


@pytest.fixture
async def client(db_engine):
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )

    async def override_get_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture
def sample_profile_data():
    return {
        "name": "Test Blog",
        "website_url": "https://testblog.com",
        "niche": "technology",
        "target_audience": "developers",
        "tone": "Conversational and friendly",
        "word_count": 2000,
        "output_format": "both",
    }


@pytest.fixture
def sample_post_data():
    return {
        "slug": f"test-post-{uuid.uuid4().hex[:8]}",
        "topic": "How to Build a REST API",
        "niche": "technology",
        "target_audience": "developers",
        "intent": "informational",
        "word_count": 2000,
    }
