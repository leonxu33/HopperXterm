// AWS S3 transport — listing + transfer against a single bucket.
// Credentials come from the shared config files (~/.aws/credentials /
// ~/.aws/config) via an optional named Profile, or the SDK default chain
// when none is given. Region is taken from the config / profile, falling
// back to AWS_REGION env var, then us-east-1.
package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3DialConfig is the minimum to reach a bucket.
type S3DialConfig struct {
	Bucket  string
	Region  string // empty → profile/env/us-east-1
	Timeout time.Duration

	// Profile selects a named section in the AWS shared config files.
	// Empty falls back to the SDK default credential chain.
	Profile string
}

// S3 wraps an S3 client targeted at a single bucket.
type S3 struct {
	Bucket string
	Region string
	client *s3.Client
	ctx    context.Context
}

// DialS3 builds an S3 client using the default credential chain. The
// bucket isn't accessed yet — call List/Head to verify reachability.
func DialS3(cfg S3DialConfig) (*S3, error) {
	if cfg.Bucket == "" {
		return nil, errors.New("transport: s3 bucket required")
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()
	awsCfg, err := loadAWSConfig(ctx, cfg.Region, cfg.Profile)
	if err != nil {
		return nil, fmt.Errorf("transport: aws config: %w", err)
	}
	return &S3{
		Bucket: cfg.Bucket,
		Region: effectiveRegion(awsCfg, cfg.Region),
		client: s3.NewFromConfig(awsCfg),
		ctx:    context.Background(),
	}, nil
}

// ListBuckets returns the names of every bucket visible to the credentials
// resolved from the given region + optional named profile. Used by the New
// Session modal's bucket picker. ListBuckets is a global operation — the
// region only selects the endpoint; the returned names span all regions.
func ListBuckets(region, profile string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	awsCfg, err := loadAWSConfig(ctx, region, profile)
	if err != nil {
		return nil, fmt.Errorf("transport: aws config: %w", err)
	}
	out, err := s3.NewFromConfig(awsCfg).ListBuckets(ctx, &s3.ListBucketsInput{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Buckets))
	for _, b := range out.Buckets {
		if b.Name != nil {
			names = append(names, *b.Name)
		}
	}
	return names, nil
}

// Close is a no-op for S3 (the SDK client has no persistent connection
// to release).
func (s *S3) Close() error { return nil }

// List returns the "directory" listing at prefix using CommonPrefixes
// to fold subkeys. Pass "" for the bucket root.
func (s *S3) List(prefix string) ([]Entry, error) {
	if s.client == nil {
		return nil, errors.New("s3: not connected")
	}
	p := normalizeS3Prefix(prefix)
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	out, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:    aws.String(s.Bucket),
		Prefix:    aws.String(p),
		Delimiter: aws.String("/"),
		MaxKeys:   aws.Int32(1000),
	})
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0)
	// Directories (CommonPrefixes).
	for _, cp := range out.CommonPrefixes {
		if cp.Prefix == nil {
			continue
		}
		name := strings.TrimPrefix(*cp.Prefix, p)
		name = strings.TrimSuffix(name, "/")
		if name == "" {
			continue
		}
		entries = append(entries, Entry{Name: name, IsDir: true})
	}
	// Files.
	for _, obj := range out.Contents {
		if obj.Key == nil {
			continue
		}
		name := strings.TrimPrefix(*obj.Key, p)
		if name == "" || strings.Contains(name, "/") {
			// Either it's the prefix itself (sentinel "folder" object)
			// or a deeper key we missed via the delimiter.
			continue
		}
		var size int64
		if obj.Size != nil {
			size = *obj.Size
		}
		var ts int64
		if obj.LastModified != nil {
			ts = obj.LastModified.UnixMilli()
		}
		entries = append(entries, Entry{
			Name:      name,
			IsDir:     false,
			Size:      size,
			ModTimeMs: ts,
		})
	}
	sortEntries(entries)
	return entries, nil
}

// Cwd is always "" for S3 — there's no working directory concept.
func (s *S3) Cwd() (string, error) { return "/", nil }

// Stat returns metadata for a single object via HeadObject.
func (s *S3) Stat(p string) (Entry, error) {
	if s.client == nil {
		return Entry{}, errors.New("s3: not connected")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	key := strings.TrimPrefix(p, "/")
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return Entry{}, err
	}
	name := key
	if i := strings.LastIndex(key, "/"); i >= 0 {
		name = key[i+1:]
	}
	e := Entry{Name: name}
	if out.ContentLength != nil {
		e.Size = *out.ContentLength
	}
	if out.LastModified != nil {
		e.ModTimeMs = out.LastModified.UnixMilli()
	}
	return e, nil
}

// Mkdir for S3 means creating a zero-byte sentinel object with a
// trailing slash. parents is ignored — S3 has no real hierarchy.
func (s *S3) Mkdir(p string, _ bool) error {
	if s.client == nil {
		return errors.New("s3: not connected")
	}
	key := normalizeS3Prefix(p) // ensures trailing "/"
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(key),
		Body:   strings.NewReader(""),
	})
	return err
}

// Remove deletes a single key. For "directories" (prefixes) the
// caller must use RemoveAll.
func (s *S3) Remove(p string) error {
	if s.client == nil {
		return errors.New("s3: not connected")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(strings.TrimPrefix(p, "/")),
	})
	return err
}

// RemoveAll deletes a prefix tree. Lists, batches up to 1000 keys per
// DeleteObjects call.
func (s *S3) RemoveAll(p string) error {
	if s.client == nil {
		return errors.New("s3: not connected")
	}
	prefix := normalizeS3Prefix(p)
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute)
	defer cancel()
	var continuation *string
	for {
		out, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.Bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuation,
			MaxKeys:           aws.Int32(1000),
		})
		if err != nil {
			return err
		}
		if len(out.Contents) == 0 {
			break
		}
		ids := make([]types.ObjectIdentifier, 0, len(out.Contents))
		for _, o := range out.Contents {
			if o.Key != nil {
				ids = append(ids, types.ObjectIdentifier{Key: o.Key})
			}
		}
		if _, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.Bucket),
			Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)},
		}); err != nil {
			return err
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			break
		}
		continuation = out.NextContinuationToken
	}
	return nil
}

// UploadDir / DownloadDir for S3 — recursive transfer support is
// deferred (S3's lack of real directories needs different handling
// from SFTP's tree walk).
func (s *S3) UploadDir(localDir, remoteDir string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	return 0, errors.New("s3: recursive directory upload not yet supported")
}

func (s *S3) DownloadDir(remoteDir, localDir string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	return 0, errors.New("s3: recursive directory download not yet supported")
}

// Create writes an empty object at the given key.
func (s *S3) Create(p string) error {
	if s.client == nil {
		return errors.New("s3: not connected")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(strings.TrimPrefix(p, "/")),
		Body:   strings.NewReader(""),
	})
	return err
}

// Rename = Copy + Delete on S3. Atomicity is not guaranteed.
func (s *S3) Rename(src, dst string) error {
	if s.client == nil {
		return errors.New("s3: not connected")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 60*time.Second)
	defer cancel()
	srcKey := strings.TrimPrefix(src, "/")
	dstKey := strings.TrimPrefix(dst, "/")
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(s.Bucket),
		Key:        aws.String(dstKey),
		CopySource: aws.String(s.Bucket + "/" + srcKey),
	})
	if err != nil {
		return err
	}
	_, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(srcKey),
	})
	return err
}

// Download streams an object to localPath.
func (s *S3) Download(remotePath, localPath string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	if s.client == nil {
		return 0, errors.New("s3: not connected")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 1*time.Hour)
	defer cancel()
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(strings.TrimPrefix(remotePath, "/")),
	})
	if err != nil {
		return 0, fmt.Errorf("s3 get %s: %w", remotePath, err)
	}
	defer out.Body.Close()
	dst, err := os.Create(localPath)
	if err != nil {
		return 0, err
	}
	n, cerr := copyWithProgress(dst, out.Body, progress)
	_ = dst.Close() // close before any unlink — Windows won't remove an open file
	if cerr != nil {
		discardPartial(func() error { return os.Remove(localPath) })
		return n, cerr
	}
	return n, nil
}

// Upload streams localPath to remotePath.
func (s *S3) Upload(localPath, remotePath string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	if s.client == nil {
		return 0, errors.New("s3: not connected")
	}
	src, err := os.Open(localPath)
	if err != nil {
		return 0, err
	}
	defer src.Close()
	fi, err := src.Stat()
	if err != nil {
		return 0, err
	}
	pr := &progressReader{r: src, total: fi.Size(), progress: progress}
	ctx, cancel := context.WithTimeout(s.ctx, 1*time.Hour)
	defer cancel()
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.Bucket),
		Key:           aws.String(strings.TrimPrefix(remotePath, "/")),
		Body:          pr,
		ContentLength: aws.Int64(fi.Size()),
	})
	if err != nil {
		return pr.read, err
	}
	return pr.read, nil
}

// progressReader wraps io.Reader to report bytes read.
type progressReader struct {
	r        io.Reader
	read     int64
	total    int64
	progress ProgressFunc
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.read += int64(n)
		if p.progress != nil {
			if perr := p.progress(p.read); perr != nil {
				return n, perr
			}
		}
	}
	return n, err
}

// normalizeS3Prefix ensures a trailing "/" so ListObjectsV2 with a
// delimiter behaves like a directory listing. An empty input stays
// empty (= bucket root).
func normalizeS3Prefix(p string) string {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return ""
	}
	if !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}
